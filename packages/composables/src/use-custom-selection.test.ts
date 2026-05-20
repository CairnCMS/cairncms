import { expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { useCustomSelectionMultiple } from './use-custom-selection.js';

test('editing a previously unselected custom value does not append it to the selection', () => {
	const currentValues = ref(['a', 'b']);
	const items = ref<any[]>([]);
	const emit = vi.fn();

	const { otherValues, addOtherValue, setOtherValue } = useCustomSelectionMultiple(currentValues, items, emit);

	addOtherValue();

	const newRow = otherValues.value[otherValues.value.length - 1];
	setOtherValue(newRow!.key, 'c');

	expect(emit).toHaveBeenLastCalledWith(['a', 'b']);
});

test('editing a selected custom value replaces it in the selection', () => {
	const currentValues = ref(['a', 'b']);
	const items = ref<any[]>([]);
	const emit = vi.fn();

	const { otherValues, setOtherValue } = useCustomSelectionMultiple(currentValues, items, emit);

	const rowForA = otherValues.value.find((o) => o.value === 'a');
	setOtherValue(rowForA!.key, 'x');

	expect(emit).toHaveBeenLastCalledWith(['b', 'x']);
});
