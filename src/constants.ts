export const EXT_COMMON_NAME = "DS SAST";
export const EXT_NAME = "ds-sast";
export const SEMGREP_TIMEOUT_MS = 240 * 1000; // Semgrep timeout to be used when scanning HCL files
export const REMOTEDB_INIT_TIMEOUT_MS = 10 * 1000;
export const RW_CHECK_COLLECTION = "readWriteCheckCollection";
export const PROJECT_DIR_COLLECTION = "projectDir";
export const PROJECT_DIR_DB = "projectDirDB.db";
export const IAC_FOLDER_NAME = "ds-sast-data";
export const DIAGNOSTICS_COLLECTION_PREFIX = "diagnostics_";
export const COMMENTS_COLLECTION_PREFIX = "comments_";
export const DIAGNOSTICS_CODENAME = 'ds-sast';
export const IAC_POI_MESSAGE = "IaC Point Of Intersection:";
export const INFRAMAP_TIMEOUT_MS = 10 * 1000;
export const INFRAMAP_DOWNLOADED_STATENAME = "inframapDownloading";

export const INFRAMAP_RELEASES: { [id: string] : any; } = {
    "linux": {
        "url": "https://github.com/cycloidio/inframap/releases/download/v0.6.7/inframap-linux-amd64.tar.gz",
        "integrity": "sha384-a8ANZlhXEgA64SjPBtbJiV3T33/wmxFImZMJTJpWJmffNGDJwnu6/knZDsHtZNz3"
    },
    "darwin": {
        "url": "https://github.com/cycloidio/inframap/releases/download/v0.6.7/inframap-darwin-amd64.tar.gz",
        "integrity": "sha384-eSEnikqoFvap1D9sSl6Y7Ka9TEPnWBvvWJ9unHPMqJVcXeHgHMcmeTjZvJ4hYEZT"
    }
};

// Set this to true to use <= MongoDB 4.X
export const IS_MONGO_4 = false;