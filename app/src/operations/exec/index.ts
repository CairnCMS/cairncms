import { DeepPartial, Field } from '@cairncms/types';
import { defineOperationApp } from '@cairncms/utils';

export default defineOperationApp({
	id: 'exec',
	icon: 'code',
	name: '$t:operations.exec.name',
	description: '$t:operations.exec.description',
	overview: () => [],
	options: () => {
		const standard: DeepPartial<Field>[] = [
			{
				field: 'code',
				name: '$t:code',
				type: 'string',
				meta: {
					width: 'full',
					interface: 'input-code',
					options: {
						language: 'javascript',
					},
				},
				schema: {
					default_value: `module.exports = async function(data) {
	// Transform data here. The script runs in an isolated sandbox without require().
	return {};
}`,
				},
			},
		];

		return standard;
	},
});
