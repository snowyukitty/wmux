export {
  snapshotFile,
  assertUnchanged,
  ConfigChangedError,
  type FileSnapshot,
} from './snapshot';

export {
  backupFile,
  type BackupOptions,
} from './backup';

export {
  writeFileAtomic,
} from './atomicWrite';

export {
  editJsonKeys,
  JsonEditError,
  type JsonEdit,
} from './jsonEdit';

export {
  editTomlKeys,
  TomlEditError,
  type TomlEdit,
  type TomlTableEdit,
  type TomlArrayTableEdit,
} from './tomlEdit';

export {
  applyConfigEdit,
  type ApplyConfigEditOptions,
  type ApplyConfigEditResult,
} from './applyConfigEdit';

export { foldPathCase } from './pathCase';

export {
  rollbackWrittenFiles,
  type WrittenFile,
} from './rollback';

export {
  SurfacesStore,
  type RemovedHookEntry,
  type SurfacesStoreData,
} from './surfacesStore';

export {
  isVersionInRange,
  parseSemver,
  compareSemver,
  type VersionRange,
  type ParsedSemver,
} from './versionRange';
