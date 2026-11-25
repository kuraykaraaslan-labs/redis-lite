/**
 * @deprecated Compatibility shim (step 2): propagation rules moved to PersistenceService (persistence.propagate.service.ts)
 * and the execution-unit model to persistence.propagator.ts. Kept because server.core imports `Propagator` from here.
 */
export { Propagator } from './persistence.propagator';
export type { PropagatedOp, PropagationSink, PropagatorOptions, RecordHints } from './persistence.types';
