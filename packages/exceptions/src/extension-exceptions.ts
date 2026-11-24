import { BaseException } from './base.js';
import { ContentTooLargeException } from './content-too-large.js';
import { FailedValidationException } from './failed-validation.js';
import { ForbiddenException } from './forbidden.js';
import { HitRateLimitException } from './hit-rate-limit.js';
import { InvalidCredentialsException } from './invalid-credentials.js';
import { InvalidPayloadException } from './invalid-payload.js';
import { InvalidQueryException } from './invalid-query.js';
import { MethodNotAllowedException } from './method-not-allowed.js';
import { RouteNotFoundException } from './route-not-found.js';
import { ServiceUnavailableException } from './service-unavailable.js';
import { UnprocessableEntityException } from './unprocessable-entity.js';
import { UnsupportedMediaTypeException } from './unsupported-media-type.js';

/** The common exception classes that extensions and operations receive in their context. */
export const extensionExceptions = {
	BaseException,
	ContentTooLargeException,
	FailedValidationException,
	ForbiddenException,
	HitRateLimitException,
	InvalidCredentialsException,
	InvalidPayloadException,
	InvalidQueryException,
	MethodNotAllowedException,
	RouteNotFoundException,
	ServiceUnavailableException,
	UnprocessableEntityException,
	UnsupportedMediaTypeException,
};
