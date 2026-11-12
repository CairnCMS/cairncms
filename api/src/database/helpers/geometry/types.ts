import { GEOMETRY_TYPES } from '@cairncms/constants';
import type { Field, RawField } from '@cairncms/types';
import type { Knex } from 'knex';
import type { GeoJSONGeometry } from 'wellknown';
import { stringify as geojsonToWKT } from 'wellknown';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import { DatabaseHelper } from '../types.js';

export abstract class GeometryHelper extends DatabaseHelper {
	supported(): boolean | Promise<boolean> {
		return true;
	}

	isTrue(expression: Knex.Raw) {
		return expression;
	}

	isFalse(expression: Knex.Raw) {
		return expression.wrap('NOT ', '');
	}

	protected geometrySubtype(field: RawField | Field): (typeof GEOMETRY_TYPES)[number] | undefined {
		if (field.type === 'geometry') return undefined;

		const subtype = GEOMETRY_TYPES.find((name) => field.type === `geometry.${name}`);
		if (!subtype) throw new InvalidPayloadException(`Illegal type passed: "${field.type}"`);

		return subtype;
	}

	createColumn(table: Knex.CreateTableBuilder, field: RawField | Field) {
		return table.specificType(field.field, this.geometrySubtype(field) ?? 'geometry');
	}

	asText(table: string, column: string): Knex.Raw {
		return this.knex.raw('st_astext(??.??) as ??', [table, column, column]);
	}

	fromText(text: string): Knex.Raw {
		return this.knex.raw('st_geomfromtext(?, 4326)', text);
	}

	fromGeoJSON(geojson: GeoJSONGeometry): Knex.Raw {
		return this.fromText(geojsonToWKT(geojson));
	}

	_intersects(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		const geometry = this.fromGeoJSON(geojson);
		return this.knex.raw('st_intersects(??, ?)', [key, geometry]);
	}

	intersects(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		return this.isTrue(this._intersects(key, geojson));
	}

	nintersects(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		return this.isFalse(this._intersects(key, geojson));
	}

	_intersects_bbox(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		const geometry = this.fromGeoJSON(geojson);
		return this.knex.raw('st_intersects(??, ?)', [key, geometry]);
	}

	intersects_bbox(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		return this.isTrue(this._intersects_bbox(key, geojson));
	}

	nintersects_bbox(key: string, geojson: GeoJSONGeometry): Knex.Raw {
		return this.isFalse(this._intersects_bbox(key, geojson));
	}

	collect(table: string, column: string): Knex.Raw {
		return this.knex.raw('st_astext(st_collect(??.??))', [table, column]);
	}
}
