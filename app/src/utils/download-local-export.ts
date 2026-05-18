import api from '@/api';
import { getEndpoint } from '@cairncms/utils';
import { saveAs } from 'file-saver';

export type ExportSettings = {
	sort?: string;
	fields?: string[];
	search?: string;
	filter?: Record<string, any>;
	limit?: number;
};

export function buildExportParams(format: string, settings: ExportSettings): Record<string, unknown> {
	const params: Record<string, unknown> = { export: format };

	if (settings.sort && settings.sort !== '') params['sort'] = settings.sort;
	if (settings.fields) params['fields'] = settings.fields;
	if (settings.search) params['search'] = settings.search;
	if (settings.filter) params['filter'] = settings.filter;

	params['limit'] = settings.limit ?? -1;

	return params;
}

const FILENAME_STAR = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i;
const FILENAME = /filename\s*=\s*"?([^";]+)"?/i;

export function getFilenameFromContentDisposition(header: string | undefined | null): string | null {
	if (!header) return null;

	const starMatch = header.match(FILENAME_STAR);

	if (starMatch && starMatch[2]) {
		try {
			return decodeURIComponent(starMatch[2].trim());
		} catch {
			return starMatch[2].trim();
		}
	}

	const match = header.match(FILENAME);
	if (!match || !match[1]) return null;

	return match[1].trim();
}

export async function downloadLocalExport(collection: string, format: string, settings: ExportSettings): Promise<void> {
	const response = await api.get(getEndpoint(collection), {
		params: buildExportParams(format, settings),
		responseType: 'blob',
	});

	const filename =
		getFilenameFromContentDisposition(response.headers?.['content-disposition']) ?? `${collection}.${format}`;

	saveAs(response.data, filename);
}
