import { BaseException } from '@cairncms/exceptions';

export class IllegalAssetTransformation extends BaseException<Record<string, never>> {
	constructor(message: string) {
		super(message, 400, 'ILLEGAL_ASSET_TRANSFORMATION');
	}
}
