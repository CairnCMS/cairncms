import type { Driver } from '@cairncms/storage';

export const _aliasMap: Record<string, string> = {
	local: '@cairncms/storage-driver-local',
	s3: '@cairncms/storage-driver-s3',
	gcs: '@cairncms/storage-driver-gcs',
	azure: '@cairncms/storage-driver-azure',
	cloudinary: '@cairncms/storage-driver-cloudinary',
};

export const getStorageDriver = async (driverName: string): Promise<typeof Driver> => {
	if (driverName in _aliasMap) {
		driverName = _aliasMap[driverName]!;
	} else {
		throw new Error(`Driver "${driverName}" doesn't exist.`);
	}

	return (await import(driverName)).default;
};
