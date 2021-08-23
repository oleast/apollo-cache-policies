import _ from "lodash";
import {
  gql,
  InMemoryCache,
  Cache,
  NormalizedCacheObject,
  Reference,
  StoreObject,
  makeReference,
} from "@apollo/client/core";
import InvalidationPolicyManager from "../policies/InvalidationPolicyManager";
import { EntityStoreWatcher, EntityTypeMap } from "../entity-store";
import { makeEntityId, isQuery, maybeDeepClone, fieldNameFromStoreName } from "../helpers";
import { InvalidationPolicyCacheConfig } from "./types";
import { CacheResultProcessor, ReadResultStatus } from "./CacheResultProcessor";
import { InvalidationPolicyEvent, ReadFieldOptions } from "../policies/types";
import { FragmentDefinitionNode } from 'graphql';
import { cacheExtensionsCollectionTypename, collectionEntityIdForType } from './utils';

/**
 * Extension of Apollo in-memory cache which adds support for cache policies.
 */
export default class InvalidationPolicyCache extends InMemoryCache {
  protected entityTypeMap: EntityTypeMap;
  protected invalidationPolicyManager: InvalidationPolicyManager;
  protected cacheResultProcessor: CacheResultProcessor;
  protected entityStoreRoot: any;
  protected isBroadcasting: boolean;

  constructor(config: InvalidationPolicyCacheConfig = {}) {
    const { invalidationPolicies = {}, ...inMemoryCacheConfig } = config;
    super(inMemoryCacheConfig);

    // @ts-ignore
    this.entityStoreRoot = this.data;
    this.isBroadcasting = false;
    this.entityTypeMap = new EntityTypeMap();

    new EntityStoreWatcher({
      entityStore: this.entityStoreRoot,
      entityTypeMap: this.entityTypeMap,
      policies: this.policies,
      updateCollectionField: this.updateCollectionField.bind(this),
    });

    this.invalidationPolicyManager = new InvalidationPolicyManager({
      policies: invalidationPolicies,
      entityTypeMap: this.entityTypeMap,
      cacheOperations: {
        evict: (...args) => this.evict(...args),
        modify: (...args) => this.modify(...args),
        readField: (...args) => this.readField(...args),
      },
    });
    this.cacheResultProcessor = new CacheResultProcessor({
      invalidationPolicyManager: this.invalidationPolicyManager,
      entityTypeMap: this.entityTypeMap,
      cache: this,
    });
  }

  protected readField<T>(
    fieldNameOrOptions?: string | ReadFieldOptions,
    from?: StoreObject | Reference
  ) {
    if (!fieldNameOrOptions) {
      return;
    }

    const options = typeof fieldNameOrOptions === "string"
      ? {
        fieldName: fieldNameOrOptions,
        from,
      }
      : fieldNameOrOptions;

    if (void 0 === options.from) {
      options.from = { __ref: 'ROOT_QUERY' };
    }

    return this.policies.readField<T>(
      options,
      {
        store: this.entityStoreRoot,
      }
    );
  }

  protected broadcastWatches() {
    this.isBroadcasting = true;
    super.broadcastWatches();
    this.isBroadcasting = false;
  }

  // Determines whether the cache's data reference is set to the root store. If not, then there is an ongoing optimistic transaction
  // being applied to a new layer.
  isOperatingOnRootData() {
    // @ts-ignore
    return this.data === this.entityStoreRoot;
  }

  modify(options: Cache.ModifyOptions) {
    const modifyResult = super.modify(options);

    if (
      !this.invalidationPolicyManager.isPolicyEventActive(
        InvalidationPolicyEvent.Write
      ) ||
      !modifyResult
    ) {
      return modifyResult;
    }

    const { id = "ROOT_QUERY", fields } = options;

    if (isQuery(id)) {
      Object.keys(fields).forEach((storeFieldName) => {
        const fieldName = fieldNameFromStoreName(storeFieldName);

        const typename = this.entityTypeMap.readEntityById(
          makeEntityId(id, fieldName)
        )?.typename;

        if (!typename) {
          return;
        }

        this.invalidationPolicyManager.runWritePolicy(typename, {
          parent: {
            id,
            fieldName,
            storeFieldName,
            ref: makeReference(id),
          },
        });
      });
    } else {
      const typename = this.entityTypeMap.readEntityById(id)?.typename;

      if (!typename) {
        return modifyResult;
      }

      this.invalidationPolicyManager.runWritePolicy(typename, {
        parent: {
          id,
          ref: makeReference(id),
        },
      });
    }

    if (options.broadcast) {
      this.broadcastWatches();
    }

    return modifyResult;
  }

  write(options: Cache.WriteOptions<any, any>) {
    const writeResult = super.write(options);

    // Do not trigger a write policy if the current write is being applied to an optimistic data layer since
    // the policy will later be applied when the server data response is received.
    if (
      (!this.invalidationPolicyManager.isPolicyEventActive(
        InvalidationPolicyEvent.Write
      ) &&
        !this.invalidationPolicyManager.isPolicyEventActive(
          InvalidationPolicyEvent.Read
        )) ||
      !this.isOperatingOnRootData()
    ) {
      return writeResult;
    }

    this.cacheResultProcessor.processWriteResult(options);

    if (options.broadcast) {
      this.broadcastWatches();
    }

    return writeResult;
  }

  evict(options: Cache.EvictOptions): boolean {
    const { fieldName, args } = options;
    let { id } = options;
    if (!id) {
      if (Object.prototype.hasOwnProperty.call(options, "id")) {
        return false;
      }
      id = "ROOT_QUERY";
    }

    if (
      this.invalidationPolicyManager.isPolicyEventActive(
        InvalidationPolicyEvent.Evict
      )
    ) {
      const { typename } =
        this.entityTypeMap.readEntityById(makeEntityId(id, fieldName)) ?? {};

      if (typename) {
        const storeFieldName =
          isQuery(id) && fieldName
            ? this.policies.getStoreFieldName({
              typename,
              fieldName,
              args,
            })
            : undefined;

        this.invalidationPolicyManager.runEvictPolicy(typename, {
          parent: {
            id,
            fieldName,
            storeFieldName,
            variables: args,
            ref: makeReference(id),
          },
        });
      }
    }

    return super.evict(options);
  }

  protected updateCollectionField(typename: string, dataId: string) {
    const collectionEntityId = collectionEntityIdForType(typename);
    const collectionFieldExists = !!this.readField<Record<string, any[]>>('id', makeReference(collectionEntityId));

    // If the collection field for the type does not exist in the cache, then initialize it as
    // an empty array.
    if (!collectionFieldExists) {
      this.writeFragment({
        id: collectionEntityId,
        fragment: gql`
          fragment InitializeCollectionEntity on CacheExtensionsCollectionEntity {
            data
            id
          }
        `,
        data: {
          __typename: cacheExtensionsCollectionTypename,
          id: typename,
          data: [],
        },
      });
    }

    // If the entity does not already exist in the cache, add it to the collection field policy for its type
    if (!this.entityTypeMap.readEntityById(dataId)) {
      this.modify({
        broadcast: false,
        id: collectionEntityId,
        fields: {
          data: (existing) => {
            return [
              ...existing,
              makeReference(dataId),
            ]
          }
        }
      });
    }
  }

  // Returns all expired entities whose cache time exceeds their type's timeToLive or as a fallback
  // the global timeToLive if specified. Evicts the expired entities by default, with an option to only report
  // them.
  private _expire(reportOnly = false) {
    const { entitiesById } = this.entityTypeMap.extract();
    const expiredEntityIds: string[] = [];

    Object.keys(entitiesById).forEach((entityId) => {
      const entity = entitiesById[entityId];
      const { storeFieldNames, dataId, fieldName, typename } = entity;

      if (isQuery(dataId) && storeFieldNames) {
        Object.keys(storeFieldNames.entries).forEach((storeFieldName) => {
          const isExpired = this.invalidationPolicyManager.runReadPolicy({
            typename,
            dataId,
            fieldName,
            storeFieldName,
            reportOnly,
          });
          if (isExpired) {
            expiredEntityIds.push(makeEntityId(dataId, storeFieldName));
          }
        });
      } else {
        const isExpired = this.invalidationPolicyManager.runReadPolicy({
          typename,
          dataId,
          fieldName,
          reportOnly,
        });
        if (isExpired) {
          expiredEntityIds.push(makeEntityId(dataId));
        }
      }
    });

    if (expiredEntityIds.length > 0) {
      this.broadcastWatches();
    }

    return expiredEntityIds;
  }

  // Expires all entities still present in the cache that have exceeded their timeToLive. By default entities are evicted
  // lazily on read if their entity is expired. Use this expire API to eagerly remove expired entities.
  expire() {
    return this._expire(false);
  }

  // Returns all expired entities still present in the cache.
  expiredEntities() {
    return this._expire(true);
  }

  // Activates the provided policy events (on read, on write, on evict) or by default all policy events.
  activatePolicyEvents(...policyEvents: InvalidationPolicyEvent[]) {
    if (policyEvents.length > 0) {
      this.invalidationPolicyManager.activatePolicies(...policyEvents);
    } else {
      this.invalidationPolicyManager.activatePolicies(
        InvalidationPolicyEvent.Read,
        InvalidationPolicyEvent.Write,
        InvalidationPolicyEvent.Evict
      );
    }
  }

  // Deactivates the provided policy events (on read, on write, on evict) or by default all policy events.
  deactivatePolicyEvents(...policyEvents: InvalidationPolicyEvent[]) {
    if (policyEvents.length > 0) {
      this.invalidationPolicyManager.deactivatePolicies(...policyEvents);
    } else {
      this.invalidationPolicyManager.deactivatePolicies(
        InvalidationPolicyEvent.Read,
        InvalidationPolicyEvent.Write,
        InvalidationPolicyEvent.Evict
      );
    }
  }

  // Returns the policy events that are currently active.
  activePolicyEvents() {
    return [
      InvalidationPolicyEvent.Read,
      InvalidationPolicyEvent.Write,
      InvalidationPolicyEvent.Evict
    ].filter(policyEvent => this.invalidationPolicyManager.isPolicyEventActive(policyEvent));
  }

  read<T>(options: Cache.ReadOptions<any>): T | null {
    const result = super.read<T>(options);

    if (
      !this.invalidationPolicyManager.isPolicyEventActive(
        InvalidationPolicyEvent.Read
      )
    ) {
      return result;
    }

    const processedResult = maybeDeepClone(result);
    const processedResultStatus = this.cacheResultProcessor.processReadResult(
      processedResult,
      options
    );

    if (processedResultStatus === ReadResultStatus.Complete) {
      return result;
    }

    this.broadcastWatches();

    return processedResultStatus === ReadResultStatus.Evicted
      ? null
      : processedResult;
  }

  diff<T>(options: Cache.DiffOptions): Cache.DiffResult<T> {
    const cacheDiff = super.diff<T>(options);

    // Diff calls made by `broadcastWatches` should not trigger the read policy
    // as these are internal reads not reflective of client action and can lead to recursive recomputation of cached data which is an error.
    // Instead, diffs will trigger the read policies for client-based reads like `readCache` invocations from watched queries outside
    // the scope of broadcasts.
    if (
      !this.invalidationPolicyManager.isPolicyEventActive(
        InvalidationPolicyEvent.Read
      ) ||
      this.isBroadcasting
    ) {
      return cacheDiff;
    }

    const { result } = cacheDiff;

    const processedResult = maybeDeepClone(result);
    const processedResultStatus = this.cacheResultProcessor.processReadResult(
      processedResult,
      options
    );

    if (processedResultStatus === ReadResultStatus.Complete) {
      return cacheDiff;
    }

    this.broadcastWatches();

    cacheDiff.complete = false;
    cacheDiff.result =
      processedResultStatus === ReadResultStatus.Evicted
        ? undefined
        : processedResult;

    return cacheDiff;
  }

  extract(optimistic = false, withInvalidation = true): NormalizedCacheObject {
    const extractedCache = super.extract(optimistic);

    if (withInvalidation) {
      // The entitiesById are sufficient alone for reconstructing the type map, so to
      // minimize payload size only inject the entitiesById object into the extracted cache
      extractedCache.invalidation = _.pick(
        this.entityTypeMap.extract(),
        "entitiesById"
      );
    }

    return extractedCache;
  }

  // Supports reading a collection of entities by type from the cache and filtering them by the given fields. Returns
  // a list of the dereferenced matching entities from the cache based on the given fragment.
  readFragmentWhere<FragmentType, TVariables = any>(options: Cache.ReadFragmentOptions<FragmentType, TVariables> & {
    filters: Partial<Record<keyof FragmentType, any>>
  }): FragmentType[] {
    const { fragment, filters, ...restOptions } = options;
    const fragmentDefinition = fragment.definitions[0] as FragmentDefinitionNode;
    const __typename = fragmentDefinition.typeCondition.name.value;

    const matchingRefs = this.readReferenceWhere(
      {
        __typename,
        ...filters
      }
    );

    const matchingFragments = matchingRefs.map(ref => this.readFragment({
      ...restOptions,
      fragment,
      id: ref.__ref,
    }));

    return _.compact(matchingFragments);
  }

  // Supports reading a collection of references by type from the cache and filtering them by the given fields. Returns a
  // list of the matching references.
  readReferenceWhere<T>(options: Partial<Record<keyof T, any>> & {
    __typename: string,
  }) {
    const { __typename, ...filters } = options;
    const collectionEntityName = collectionEntityIdForType(__typename);
    const entityReferences = this.readField<Reference[]>('data', makeReference(collectionEntityName));

    if (!entityReferences) {
      return [];
    }

    return entityReferences.filter(ref => {
      const entityFilterResults = Object.keys(filters).map(filterField => {
        // @ts-ignore
        const filterValue = filters[filterField];
        const entityValueForFilter = this.readField(filterField, ref);

        if (_.isFunction(filterValue)) {
          return filterValue(entityValueForFilter);
        }

        return filterValue === entityValueForFilter;
      });

      return _.every(entityFilterResults, Boolean);
    });
  }
}
