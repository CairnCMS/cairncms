/* eslint-disable no-console */
import { test } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const body = () => {
	console.log('FORBIDDEN_OPTION_BODY_EXECUTED');
};

switch (process.env.CONTROL_OPTION) {
	case 'only':
		test.only('exclusive control', body);
		break;
	case 'retry':
		test('retry control', { retry: 1 }, body);
		break;
	case 'repeats':
		test('repeat control', { repeats: 1 }, body);
		break;
	case 'fails':
		test.fails('inverted failure control', body);
		break;
	case 'concurrent':
		test.concurrent('concurrent control', body);
		break;
	default:
		throw new Error('Unknown native option control');
}
