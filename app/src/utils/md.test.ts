// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { md } from './md';

test('renders headings without generated id attributes', () => {
	expect(md('# Big Heading')).toBe('<h1>Big Heading</h1>\n');

	const container = document.createElement('div');
	container.innerHTML = md('# Big Heading');
	expect(container.querySelector('h1')?.hasAttribute('id')).toBe(false);
});

test.each([
	{ str: '### Heading Text', expected: '<h3>Heading Text</h3>\n' },
	{
		str: '<user@example.com>',
		expected: '<p><a target="_self" href="mailto:user@example.com">user@example.com</a></p>\n',
	},
])('renders "$str" into "$expected"', ({ str, expected }) => {
	expect(md(str)).toBe(expected);
});

test('links with target _blank keep the rel noopener noreferrer contract', () => {
	expect(md('[link](https://example.com)', { target: '_blank' })).toBe(
		'<p><a target="_blank" href="https://example.com" rel="noopener noreferrer">link</a></p>\n'
	);
});

test('sanitizes dangerous HTML in rendered markdown', () => {
	const clean = md('<script>alert(1)</script><img src=x onerror="alert(2)">');
	expect(clean).not.toContain('<script');
	expect(clean).not.toContain('onerror');
});

test('drops javascript URLs from links', () => {
	expect(md('[click](javascript:alert(1))')).not.toContain('javascript:');
});
