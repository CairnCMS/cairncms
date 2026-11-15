import { BaseException } from '@cairncms/exceptions';

export class RecordStillReferencedException extends BaseException<Record<string, never>> {
	constructor() {
		super(`Item can't be deleted because other items still reference it.`, 400, 'RECORD_STILL_REFERENCED');
	}
}
