"use strict";

/*
 * Small JSON Schema subset validator, enough for the editable module
 * schemas in ../schemas. Supported keywords:
 *   type (object|array|string|integer|number|boolean), properties,
 *   required, additionalProperties (false by default for objects),
 *   items, minItems, maxItems, enum, pattern, minLength, maxLength,
 *   minimum, maximum, format (hexcolor|url|ical-url|regex),
 *   x-secret (value may be a "**SECRET_X**" placeholder)
 */

const { placeholderName } = require("./merge");

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function checkFormat (format, value) {
	switch (format) {
		case "hexcolor":
			return HEX_COLOR_RE.test(value) ? null : "must be a hex color like #4285F4";
		case "url":
		case "ical-url": {
			let parsed;
			try {
				parsed = new URL(value);
			} catch {
				return "must be a full URL";
			}
			const allowed = format === "ical-url" ? ["https:", "http:", "webcal:"] : ["https:", "http:"];
			return allowed.includes(parsed.protocol) ? null : "must start with " + allowed.join(" or ");
		}
		case "regex":
			try {
				new RegExp(value, "i");
				return null;
			} catch (err) {
				return "is not a valid regular expression (" + err.message + ")";
			}
		default:
			return null;
	}
}

function typeOk (type, value) {
	switch (type) {
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		default:
			return true;
	}
}

/**
 * @returns {string[]} error messages, empty when valid
 */
function validate (schema, value, path = "") {
	const errors = [];
	const at = path || "(root)";
	if (schema.type && !typeOk(schema.type, value)) {
		errors.push(at + " must be of type " + schema.type);
		return errors;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(at + " must be one of: " + schema.enum.join(", "));
	}
	if (typeof value === "string") {
		const isPlaceholder = schema["x-secret"] && placeholderName(value) !== null;
		if (!isPlaceholder) {
			if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(at + " is too short");
			if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(at + " is too long");
			if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(at + " has an invalid format");
			if (schema.format) {
				const problem = checkFormat(schema.format, value);
				if (problem) errors.push(at + " " + problem);
			}
		}
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push(at + " must be >= " + schema.minimum);
		if (schema.maximum !== undefined && value > schema.maximum) errors.push(at + " must be <= " + schema.maximum);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(at + " needs at least " + schema.minItems + " item(s)");
		if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(at + " allows at most " + schema.maxItems + " item(s)");
		if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, path + "[" + i + "]")));
	}
	if (schema.type === "object") {
		const props = schema.properties || {};
		for (const key of schema.required || []) {
			if (value[key] === undefined) errors.push((path ? path + "." : "") + key + " is required");
		}
		for (const key of Object.keys(value)) {
			const child = path ? path + "." + key : key;
			if (props[key]) errors.push(...validate(props[key], value[key], child));
			else if (schema.additionalProperties !== true) errors.push(child + " is not an editable field");
		}
	}
	return errors;
}

/**
 * Walk value alongside schema and call fn(stringValue, schemaNode) for each
 * x-secret string. fn returns the replacement value.
 */
function mapSecrets (schema, value, fn) {
	if (schema["x-secret"] && typeof value === "string") return fn(value, schema);
	if (Array.isArray(value) && schema.items) return value.map((item) => mapSecrets(schema.items, item, fn));
	if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
		const out = {};
		for (const key of Object.keys(value)) {
			const child = (schema.properties || {})[key];
			out[key] = child ? mapSecrets(child, value[key], fn) : value[key];
		}
		return out;
	}
	return value;
}

/** Keep only the fields a schema declares (used to sanitise live config). */
function pick (schema, value) {
	if (value === undefined || value === null) return undefined;
	if (schema.type === "object") {
		if (typeof value !== "object" || Array.isArray(value)) return undefined;
		const out = {};
		for (const key of Object.keys(schema.properties || {})) {
			const picked = pick(schema.properties[key], value[key]);
			if (picked !== undefined) out[key] = picked;
		}
		return out;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return undefined;
		return schema.items ? value.map((item) => pick(schema.items, item)).filter((item) => item !== undefined) : value;
	}
	return typeOk(schema.type, value) ? value : undefined;
}

module.exports = { validate, mapSecrets, pick, checkFormat };
