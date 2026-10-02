const path = require('node:path');

module.exports = (testPath, root = path.resolve(__dirname, '..')) =>
	'/' + path.relative(root, testPath).split(path.sep).join('/');
