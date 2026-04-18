/**
 * Reserved sentinel role ID representing public (unauthenticated) access.
 *
 * `directus_permissions` rows with `role = PUBLIC_ROLE_ID` apply to requests
 * without authentication. This replaces the previous `role IS NULL` convention
 * so the `(role, collection, action)` tuple can be enforced as unique at the
 * database level.
 *
 * The nil UUID is used because it is standard (RFC 4122), impossible to
 * collide with UUID v4 output, and visually distinct in logs/queries.
 */
export const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';
