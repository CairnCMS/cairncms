import { expect, test } from 'vitest';

import { md } from './md.js';

test.each([
	{ str: 'test', expected: '<p>test</p>\n' },
	{ str: `<a href="/test" download />`, expected: '<a href="/test"></a>' },
	{ str: `test<script>alert('alert')</script>`, expected: '<p>test</p>\n' },
	{ str: '### Heading Text', expected: '<h3>Heading Text</h3>\n' },
	{ str: '<user@example.com>', expected: '<p><a href="mailto:user@example.com">user@example.com</a></p>\n' },
])('should sanitize "$str" into "$expected"', ({ str, expected }) => {
	expect(md(str)).toBe(expected);
});
