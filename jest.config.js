'use strict';

module.exports = {
	clearMocks: true,
	testEnvironment: 'node',
	setupFiles: [ '<rootDir>/tests/jest/setup.js' ],
	testMatch: [ '<rootDir>/tests/jest/**/*.test.js' ],
	collectCoverageFrom: [ 'resources/*.js' ]
};
