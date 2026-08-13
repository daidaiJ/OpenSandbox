import {
  __export
} from "./chunk-SIAA4J6H.js";

// src/index.ts
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

// node_modules/typebox/build/system/memory/memory.mjs
var memory_exports = {};
__export(memory_exports, {
  Assign: () => Assign,
  Clone: () => Clone,
  Create: () => Create,
  Discard: () => Discard,
  Metrics: () => Metrics,
  Update: () => Update
});

// node_modules/typebox/build/system/memory/metrics.mjs
var Metrics = {
  assign: 0,
  create: 0,
  clone: 0,
  discard: 0,
  update: 0
};

// node_modules/typebox/build/system/memory/assign.mjs
function Assign(left, right) {
  Metrics.assign += 1;
  return { ...left, ...right };
}

// node_modules/typebox/build/guard/guard.mjs
var guard_exports = {};
__export(guard_exports, {
  Counted: () => Counted,
  Entries: () => Entries,
  EntriesRegExp: () => EntriesRegExp,
  Every: () => Every,
  EveryAll: () => EveryAll,
  GraphemeCount: () => GraphemeCount2,
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsClassInstance: () => IsClassInstance,
  IsConstructor: () => IsConstructor,
  IsDeepEqual: () => IsDeepEqual,
  IsEqual: () => IsEqual,
  IsFunction: () => IsFunction,
  IsGreaterEqualThan: () => IsGreaterEqualThan,
  IsGreaterThan: () => IsGreaterThan,
  IsInteger: () => IsInteger,
  IsLessEqualThan: () => IsLessEqualThan,
  IsLessThan: () => IsLessThan,
  IsMaxLength: () => IsMaxLength2,
  IsMinLength: () => IsMinLength2,
  IsMultipleOf: () => IsMultipleOf,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsObjectNotArray: () => IsObjectNotArray,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUndefined: () => IsUndefined,
  IsUnsafePropertyKey: () => IsUnsafePropertyKey,
  IsValueLike: () => IsValueLike,
  Keys: () => Keys,
  ShiftLeft: () => ShiftLeft,
  Some: () => Some,
  SomeAll: () => SomeAll,
  Symbols: () => Symbols,
  Values: () => Values
});

// node_modules/typebox/build/guard/string.mjs
function IsBetween(value, min, max) {
  return value >= min && value <= max;
}
function IsZeroWidthJoiner(value) {
  return value === 8205;
}
function IsHighSurrogate(value) {
  return IsBetween(value, 55296, 56319);
}
function IsRegionalIndicator(value) {
  return IsBetween(value, 127462, 127487);
}
function IsVariationSelector(value) {
  return IsBetween(value, 65024, 65039);
}
function IsCombiningMark(value) {
  return IsBetween(value, 768, 879) || IsBetween(value, 6832, 6911) || IsBetween(value, 7616, 7679) || IsBetween(value, 65056, 65071);
}
function CodePointLength(value) {
  return value > 65535 ? 2 : 1;
}
function ConsumeModifiers(value, index) {
  while (index < value.length) {
    const point = value.codePointAt(index);
    if (IsCombiningMark(point) || IsVariationSelector(point)) {
      index += CodePointLength(point);
    } else {
      break;
    }
  }
  return index;
}
function NextGraphemeClusterIndex(value, clusterStart) {
  const startCP = value.codePointAt(clusterStart);
  let clusterEnd = clusterStart + CodePointLength(startCP);
  clusterEnd = ConsumeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && value[clusterEnd] === "\u200D") {
    const nextCP = value.codePointAt(clusterEnd + 1);
    clusterEnd += 1 + CodePointLength(nextCP);
    clusterEnd = ConsumeModifiers(value, clusterEnd);
  }
  if (IsRegionalIndicator(startCP) && clusterEnd < value.length && IsRegionalIndicator(value.codePointAt(clusterEnd))) {
    clusterEnd += CodePointLength(value.codePointAt(clusterEnd));
  }
  return clusterEnd;
}
function IsGraphemeCodePoint(value) {
  return IsHighSurrogate(value) || IsCombiningMark(value) || IsVariationSelector(value) || IsZeroWidthJoiner(value);
}
function GraphemeCount(value) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
  }
  return count;
}
function IsMinLengthSegmented(value, minLength) {
  if (minLength === 0)
    return true;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count >= minLength)
      return true;
  }
  return false;
}
function IsMaxLengthSegmented(value, maxLength) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count > maxLength)
      return false;
  }
  return true;
}
function IsMinLength(value, minLength) {
  if (minLength === 0)
    return true;
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMinLengthSegmented(value, minLength);
    }
    index++;
    if (index >= minLength)
      return true;
  }
  return false;
}
function IsMaxLength(value, maxLength) {
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMaxLengthSegmented(value, maxLength);
    }
    index++;
    if (index > maxLength)
      return false;
  }
  return true;
}

// node_modules/typebox/build/guard/guard.mjs
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return IsEqual(typeof value, "bigint");
}
function IsBoolean(value) {
  return IsEqual(typeof value, "boolean");
}
function IsConstructor(value) {
  if (IsUndefined(value) || !IsFunction(value))
    return false;
  const result = Function.prototype.toString.call(value);
  if (/^class\s/.test(result))
    return true;
  if (/\[native code\]/.test(result))
    return true;
  return false;
}
function IsFunction(value) {
  return IsEqual(typeof value, "function");
}
function IsInteger(value) {
  return Number.isInteger(value);
}
function IsNull(value) {
  return IsEqual(value, null);
}
function IsNumber(value) {
  return Number.isFinite(value);
}
function IsObjectNotArray(value) {
  return IsObject(value) && !IsArray(value);
}
function IsObject(value) {
  return IsEqual(typeof value, "object") && !IsNull(value);
}
function IsString(value) {
  return IsEqual(typeof value, "string");
}
function IsSymbol(value) {
  return IsEqual(typeof value, "symbol");
}
function IsUndefined(value) {
  return IsEqual(value, void 0);
}
function IsEqual(left, right) {
  return left === right;
}
function IsGreaterThan(left, right) {
  return left > right;
}
function IsLessThan(left, right) {
  return left < right;
}
function IsLessEqualThan(left, right) {
  return left <= right;
}
function IsGreaterEqualThan(left, right) {
  return left >= right;
}
function IsMultipleOf(dividend, divisor) {
  if (IsBigInt(dividend) || IsBigInt(divisor)) {
    return BigInt(dividend) % BigInt(divisor) === 0n;
  }
  const tolerance = 1e-10;
  if (!IsNumber(dividend))
    return true;
  if (IsInteger(dividend) && 1 / divisor % 1 === 0)
    return true;
  const mod = dividend % divisor;
  return Math.min(Math.abs(mod), Math.abs(mod - divisor), Math.abs(mod + divisor)) < tolerance;
}
function IsClassInstance(value) {
  if (!IsObject(value))
    return false;
  const proto = globalThis.Object.getPrototypeOf(value);
  if (IsNull(proto))
    return false;
  return IsEqual(typeof proto.constructor, "function") && !(IsEqual(proto.constructor, globalThis.Object) || IsEqual(proto.constructor.name, "Object"));
}
function IsValueLike(value) {
  return IsBigInt(value) || IsBoolean(value) || IsNull(value) || IsNumber(value) || IsString(value) || IsUndefined(value);
}
function GraphemeCount2(value) {
  return GraphemeCount(value);
}
function IsMaxLength2(value, length) {
  return IsMaxLength(value, length);
}
function IsMinLength2(value, length) {
  return IsMinLength(value, length);
}
function Every(value, offset, callback) {
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      return false;
  }
  return true;
}
function EveryAll(value, offset, callback) {
  let result = true;
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      result = false;
  }
  return result;
}
function Some(value, callback) {
  for (let index = 0; index < value.length; index++) {
    if (callback(value[index], index))
      return true;
  }
  return false;
}
function SomeAll(value, callback) {
  let result = false;
  for (let index = 0; index < value.length; index++) {
    if (callback(value[index], index))
      result = true;
  }
  return result;
}
function Counted(value, callback) {
  return value.reduce((result, value2, index) => callback(value2, index) ? ++result : result, 0);
}
function ShiftLeft(array, true_, false_) {
  return IsEqual(array.length, 0) ? false_() : true_(array[0], array.slice(1));
}
function IsUnsafePropertyKey(key) {
  return IsEqual(key, "__proto__") || IsEqual(key, "constructor") || IsEqual(key, "prototype");
}
function HasPropertyKey(value, key) {
  return IsUnsafePropertyKey(key) ? Object.prototype.hasOwnProperty.call(value, key) : key in value;
}
function EntriesRegExp(value) {
  return Keys(value).map((key) => [new RegExp(`^${key}$`), value[key]]);
}
function Entries(value) {
  return Object.entries(value);
}
function Keys(value) {
  return Object.getOwnPropertyNames(value);
}
function Symbols(value) {
  return Object.getOwnPropertySymbols(value);
}
function Values(value) {
  return Object.values(value);
}
function DeepEqualObject(left, right) {
  if (!IsObject(right))
    return false;
  const keys = Keys(left);
  return IsEqual(keys.length, Keys(right).length) && keys.every((key) => IsDeepEqual(left[key], right[key]));
}
function DeepEqualArray(left, right) {
  return IsArray(right) && IsEqual(left.length, right.length) && left.every((_, index) => IsDeepEqual(left[index], right[index]));
}
function IsDeepEqual(left, right) {
  return IsArray(left) ? DeepEqualArray(left, right) : IsObject(left) ? DeepEqualObject(left, right) : IsEqual(left, right);
}

// node_modules/typebox/build/guard/globals.mjs
var globals_exports = {};
__export(globals_exports, {
  IsBigInt64Array: () => IsBigInt64Array,
  IsBigUint64Array: () => IsBigUint64Array,
  IsBoolean: () => IsBoolean2,
  IsDate: () => IsDate,
  IsFloat32Array: () => IsFloat32Array,
  IsFloat64Array: () => IsFloat64Array,
  IsInt16Array: () => IsInt16Array,
  IsInt32Array: () => IsInt32Array,
  IsInt8Array: () => IsInt8Array,
  IsMap: () => IsMap,
  IsNumber: () => IsNumber2,
  IsRegExp: () => IsRegExp,
  IsSet: () => IsSet,
  IsString: () => IsString2,
  IsTypeArray: () => IsTypeArray,
  IsUint16Array: () => IsUint16Array,
  IsUint32Array: () => IsUint32Array,
  IsUint8Array: () => IsUint8Array,
  IsUint8ClampedArray: () => IsUint8ClampedArray
});
function IsBoolean2(value) {
  return value instanceof Boolean;
}
function IsNumber2(value) {
  return value instanceof Number;
}
function IsString2(value) {
  return value instanceof String;
}
function IsTypeArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsInt8Array(value) {
  return value instanceof globalThis.Int8Array;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUint8ClampedArray(value) {
  return value instanceof globalThis.Uint8ClampedArray;
}
function IsInt16Array(value) {
  return value instanceof globalThis.Int16Array;
}
function IsUint16Array(value) {
  return value instanceof globalThis.Uint16Array;
}
function IsInt32Array(value) {
  return value instanceof globalThis.Int32Array;
}
function IsUint32Array(value) {
  return value instanceof globalThis.Uint32Array;
}
function IsFloat32Array(value) {
  return value instanceof globalThis.Float32Array;
}
function IsFloat64Array(value) {
  return value instanceof globalThis.Float64Array;
}
function IsBigInt64Array(value) {
  return value instanceof globalThis.BigInt64Array;
}
function IsBigUint64Array(value) {
  return value instanceof globalThis.BigUint64Array;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}

// node_modules/typebox/build/system/memory/clone.mjs
function FromClassInstance(value) {
  return value;
}
function IsSchemaObject(value) {
  return guard_exports.HasPropertyKey(value, "~kind") || guard_exports.HasPropertyKey(value, "~unsafe");
}
function FromSchemaObject(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    descriptor.value = FromValue(descriptor.value);
    if (guard_exports.IsEqual(descriptor.enumerable, true)) {
      result[key] = descriptor.value;
    } else {
      Object.defineProperty(result, key, descriptor);
    }
  }
  return result;
}
function FromPlainObject(value) {
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    result[key] = FromValue(value[key]);
  }
  for (const key of guard_exports.Symbols(value)) {
    result[key] = FromValue(value[key]);
  }
  return result;
}
function FromObject(value) {
  return guard_exports.IsClassInstance(value) ? FromClassInstance(value) : IsSchemaObject(value) ? FromSchemaObject(value) : FromPlainObject(value);
}
function FromArray(value) {
  return value.map((element) => FromValue(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromRegExp(value) {
  return new RegExp(value.source, value.flags);
}
function FromMap(value) {
  return new Map(FromValue([...value.entries()]));
}
function FromSet(value) {
  return new Set(FromValue([...value.values()]));
}
function FromValue(value) {
  return globals_exports.IsTypeArray(value) ? FromTypedArray(value) : globals_exports.IsRegExp(value) ? FromRegExp(value) : globals_exports.IsMap(value) ? FromMap(value) : globals_exports.IsSet(value) ? FromSet(value) : guard_exports.IsArray(value) ? FromArray(value) : guard_exports.IsObject(value) ? FromObject(value) : value;
}
function Clone(value) {
  Metrics.clone += 1;
  return FromValue(value);
}

// node_modules/typebox/build/system/settings/settings.mjs
var settings_exports = {};
__export(settings_exports, {
  Get: () => Get,
  Reset: () => Reset,
  Set: () => Set2
});
var settings = {
  immutableTypes: false,
  maxErrors: 8,
  maxInstantiationCount: 128,
  useAcceleration: true,
  exactOptionalPropertyTypes: false,
  enumerableKind: false,
  correctiveParse: false,
  unionPrioritySort: true
};
function Reset() {
  settings.immutableTypes = false;
  settings.maxErrors = 8;
  settings.maxInstantiationCount = 128;
  settings.useAcceleration = true;
  settings.exactOptionalPropertyTypes = false;
  settings.enumerableKind = false;
  settings.correctiveParse = false;
  settings.unionPrioritySort = true;
}
function Set2(options) {
  for (const key of guard_exports.Keys(options)) {
    const value = options[key];
    if (value !== void 0) {
      Object.defineProperty(settings, key, { value });
    }
  }
}
function Get() {
  return settings;
}

// node_modules/typebox/build/system/memory/create.mjs
function MergeHidden(left, right) {
  for (const key of Object.keys(right)) {
    Object.defineProperty(left, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: right[key]
    });
  }
  return left;
}
function Merge(left, right) {
  return { ...left, ...right };
}
function Create(hidden, enumerable, options = {}) {
  Metrics.create += 1;
  const settings2 = settings_exports.Get();
  const withOptions = Merge(enumerable, options);
  const withHidden = settings2.enumerableKind ? Merge(withOptions, hidden) : MergeHidden(withOptions, hidden);
  return settings2.immutableTypes ? Object.freeze(withHidden) : withHidden;
}

// node_modules/typebox/build/system/memory/discard.mjs
function Discard(value, propertyKeys) {
  Metrics.discard += 1;
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (propertyKeys.includes(key))
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    descriptor.value = Clone(descriptor.value);
    Object.defineProperty(result, key, descriptor);
  }
  return result;
}

// node_modules/typebox/build/system/memory/update.mjs
function Update(current, hidden, enumerable) {
  Metrics.update += 1;
  const settings2 = settings_exports.Get();
  const result = Clone(current);
  for (const key of Object.keys(hidden)) {
    Object.defineProperty(result, key, {
      configurable: true,
      writable: true,
      enumerable: settings2.enumerableKind,
      value: hidden[key]
    });
  }
  for (const key of Object.keys(enumerable)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: enumerable[key]
    });
  }
  return result;
}

// node_modules/typebox/build/type/types/schema.mjs
function IsKind(value, kind) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], kind);
}
function IsSchema(value) {
  return guard_exports.IsObject(value);
}

// node_modules/typebox/build/type/types/deferred.mjs
function Deferred(action, parameters, options) {
  return memory_exports.Create({ "~kind": "Deferred" }, { type: "deferred", action, parameters, options }, {});
}
function IsDeferred(value) {
  return IsKind(value, "Deferred");
}

// node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs
function AddReadonlyOperation(type) {
  return memory_exports.Update(type, { "~readonly": true }, {});
}
function AddReadonlyAction(type, options) {
  const result = memory_exports.Update(AddReadonlyOperation(type), {}, options);
  return result;
}
function AddReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_add.mjs
function AddOptionalOperation(type) {
  return memory_exports.Update(type, { "~optional": true }, {});
}
function AddOptionalAction(type, options) {
  const result = memory_exports.Update(AddOptionalOperation(type), {}, options);
  return result;
}
function AddOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/types/array.mjs
function _Array_(items, options) {
  return memory_exports.Create({ "~kind": "Array" }, { type: "array", items }, options);
}
function IsArray2(value) {
  return IsKind(value, "Array");
}
function ArrayOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items"]);
}

// node_modules/typebox/build/type/types/constructor.mjs
function Constructor(parameters, instanceType, options = {}) {
  return memory_exports.Create({ "~kind": "Constructor" }, { type: "constructor", parameters, instanceType }, options);
}
function IsConstructor2(value) {
  return IsKind(value, "Constructor");
}
function ConstructorOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "instanceType"]);
}

// node_modules/typebox/build/type/types/function.mjs
function _Function_(parameters, returnType, options = {}) {
  return memory_exports.Create({ ["~kind"]: "Function" }, { type: "function", parameters, returnType }, options);
}
function IsFunction2(value) {
  return IsKind(value, "Function");
}
function FunctionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "returnType"]);
}

// node_modules/typebox/build/type/types/ref.mjs
function Ref(ref, options) {
  return memory_exports.Create({ ["~kind"]: "Ref" }, { $ref: ref }, options);
}
function IsRef(value) {
  return IsKind(value, "Ref");
}

// node_modules/typebox/build/type/types/generic.mjs
function Generic(parameters, expression) {
  return memory_exports.Create({ "~kind": "Generic" }, { type: "generic", parameters, expression });
}
function IsGeneric(value) {
  return IsKind(value, "Generic");
}

// node_modules/typebox/build/type/types/any.mjs
function Any(options) {
  return memory_exports.Create({ ["~kind"]: "Any" }, {}, options);
}
function IsAny(value) {
  return IsKind(value, "Any");
}

// node_modules/typebox/build/type/types/never.mjs
var NeverPattern = "(?!)";
function Never(options) {
  return memory_exports.Create({ "~kind": "Never" }, { not: {} }, options);
}
function IsNever(value) {
  return IsKind(value, "Never");
}

// node_modules/typebox/build/type/action/_add_optional.mjs
function AddOptionalDeferred(type, options = {}) {
  return Deferred("AddOptional", [type], options);
}
function AddOptional(type, options = {}) {
  return AddOptionalAction(type, options);
}

// node_modules/typebox/build/type/types/_optional.mjs
function Optional(type) {
  return AddOptional(type);
}
function IsOptional(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~optional");
}

// node_modules/typebox/build/type/types/properties.mjs
function RequiredArray(properties) {
  return guard_exports.Keys(properties).filter((key) => !IsOptional(properties[key]));
}
function PropertyKeys(properties) {
  return guard_exports.Keys(properties);
}
function PropertyValues(properties) {
  return guard_exports.Values(properties);
}

// node_modules/typebox/build/type/types/object.mjs
function _Object_(properties, options = {}) {
  const requiredKeys = RequiredArray(properties);
  const required = requiredKeys.length > 0 ? { required: requiredKeys } : {};
  return memory_exports.Create({ "~kind": "Object" }, { type: "object", ...required, properties }, options);
}
function IsObject2(value) {
  return IsKind(value, "Object");
}
function ObjectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "properties", "required"]);
}

// node_modules/typebox/build/type/types/unknown.mjs
function Unknown(options) {
  return memory_exports.Create({ ["~kind"]: "Unknown" }, {}, options);
}
function IsUnknown(value) {
  return IsKind(value, "Unknown");
}

// node_modules/typebox/build/type/types/cyclic.mjs
function Cyclic($defs, $ref, options) {
  const defs = guard_exports.Keys($defs).reduce((result, key) => {
    return { ...result, [key]: memory_exports.Update($defs[key], {}, { $id: key }) };
  }, {});
  return memory_exports.Create({ ["~kind"]: "Cyclic" }, { $defs: defs, $ref }, options);
}
function IsCyclic(value) {
  return IsKind(value, "Cyclic");
}

// node_modules/typebox/build/type/types/unsafe.mjs
function Unsafe(schema) {
  return memory_exports.Update(schema, { ["~unsafe"]: null }, {});
}
function IsUnsafe(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "~unsafe") && guard_exports.IsNull(value["~unsafe"]);
}

// node_modules/typebox/build/system/arguments/arguments.mjs
var arguments_exports = {};
__export(arguments_exports, {
  Match: () => Match
});
function Match(args, match) {
  return match[args.length]?.(...args) ?? (() => {
    throw Error("Invalid Arguments");
  })();
}

// node_modules/typebox/build/type/types/infer.mjs
function Infer(...args) {
  const [name, extends_] = arguments_exports.Match(args, {
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ ["~kind"]: "Infer" }, { type: "infer", name, extends: extends_ }, {});
}
function IsInfer(value) {
  return IsKind(value, "Infer");
}

// node_modules/typebox/build/type/types/dependent.mjs
function Dependent(if_, then_, else_, options = {}) {
  return memory_exports.Create({ "~kind": "Dependent" }, { if: if_, then: then_, else: else_ }, options);
}
function IsDependent(value) {
  return IsKind(value, "Dependent");
}
function DependentOptions(type) {
  return memory_exports.Discard(type, ["~kind", "if", "then", "else"]);
}

// node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs
function IsTypeScriptEnumLike(value) {
  return guard_exports.IsObjectNotArray(value);
}
function TypeScriptEnumToEnumValues(type) {
  const keys = guard_exports.Keys(type).filter((key) => isNaN(key));
  return keys.reduce((result, key) => [...result, type[key]], []);
}

// node_modules/typebox/build/type/types/enum.mjs
function IsEnumValue(value) {
  return guard_exports.IsString(value) || guard_exports.IsNumber(value);
}
function Enum(value, options) {
  const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
  return memory_exports.Create({ "~kind": "Enum" }, { enum: values }, options);
}
function IsEnum(value) {
  return IsKind(value, "Enum");
}

// node_modules/typebox/build/type/types/intersect.mjs
function Intersect(types, options = {}) {
  return memory_exports.Create({ "~kind": "Intersect" }, { allOf: types }, options);
}
function IsIntersect(value) {
  return IsKind(value, "Intersect");
}
function IntersectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "allOf"]);
}

// node_modules/typebox/build/system/unreachable/unreachable.mjs
function Unreachable() {
  throw new Error("Unreachable");
}

// node_modules/typebox/build/system/hashing/hash.mjs
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
  ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
  ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
  ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
  ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
  ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
  ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
  ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
  ByteMarker2[ByteMarker2["String"] = 10] = "String";
  ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
  ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
  ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt(
  "18446744073709551616"
  /* 2 ^ 64 */
)];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
var encoder = new TextEncoder();

// node_modules/typebox/build/type/types/_codec.mjs
var EncodeBuilder = class {
  constructor(type, decode) {
    this.type = type;
    this.decode = decode;
  }
  Encode(callback) {
    const type = this.type;
    const decode = IsCodec(type) ? (value) => this.decode(type["~codec"].decode(value)) : this.decode;
    const encode = IsCodec(type) ? (value) => type["~codec"].encode(callback(value)) : callback;
    const codec = { decode, encode };
    return memory_exports.Update(this.type, { "~codec": codec }, {});
  }
};
var DecodeBuilder = class {
  constructor(type) {
    this.type = type;
  }
  Decode(callback) {
    return new EncodeBuilder(this.type, callback);
  }
};
function Codec(type) {
  return new DecodeBuilder(type);
}
function Decode(type, callback) {
  return Codec(type).Decode(callback).Encode(() => {
    throw Error("Encode not implemented");
  });
}
function Encode(type, callback) {
  return Codec(type).Decode(() => {
    throw Error("Decode not implemented");
  }).Encode(callback);
}
function IsCodec(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~codec") && guard_exports.IsObject(value["~codec"]) && guard_exports.HasPropertyKey(value["~codec"], "encode") && guard_exports.HasPropertyKey(value["~codec"], "decode");
}

// node_modules/typebox/build/type/types/_immutable.mjs
function Immutable(type) {
  return AddImmutable(type);
}
function IsImmutable(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~immutable");
}

// node_modules/typebox/build/type/action/_add_readonly.mjs
function AddReadonlyDeferred(type, options = {}) {
  return Deferred("AddReadonly", [type], options);
}
function AddReadonly(type, options = {}) {
  return AddReadonlyAction(type, options);
}

// node_modules/typebox/build/type/types/_readonly.mjs
function Readonly(type) {
  return AddReadonly(type);
}
function IsReadonly(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~readonly");
}

// node_modules/typebox/build/type/types/_refine.mjs
function RefineAdd(type, refinement) {
  const refinements = IsRefine(type) ? [...type["~refine"], refinement] : [refinement];
  return memory_exports.Update(type, { "~refine": refinements }, {});
}
function Refine(...args) {
  const [type, check, error] = arguments_exports.Match(args, {
    3: (type2, check2, error2) => [type2, check2, error2],
    2: (type2, check2) => [type2, check2, () => "Refine Error"]
  });
  return RefineAdd(type, { check, error });
}
function IsRefinement(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "check") && guard_exports.HasPropertyKey(value, "error") && guard_exports.IsFunction(value.check) && guard_exports.IsFunction(value.error);
}
function IsRefine(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => IsRefinement(value2));
}

// node_modules/typebox/build/type/types/bigint.mjs
var BigIntPattern = "-?(?:0|[1-9][0-9]*)n";
function BigInt2(options) {
  return memory_exports.Create({ "~kind": "BigInt" }, { type: "bigint" }, options);
}
function IsBigInt2(value) {
  return IsKind(value, "BigInt");
}

// node_modules/typebox/build/type/types/boolean.mjs
function Boolean2(options) {
  return memory_exports.Create({ "~kind": "Boolean" }, { type: "boolean" }, options);
}
function IsBoolean3(value) {
  return IsKind(value, "Boolean");
}

// node_modules/typebox/build/type/types/identifier.mjs
function Identifier(name) {
  return memory_exports.Create({ "~kind": "Identifier" }, { name });
}
function IsIdentifier(value) {
  return IsKind(value, "Identifier");
}

// node_modules/typebox/build/type/types/integer.mjs
var IntegerPattern = "-?(?:0|[1-9][0-9]*)";
function Integer(options) {
  return memory_exports.Create({ "~kind": "Integer" }, { type: "integer" }, options);
}
function IsInteger2(value) {
  return IsKind(value, "Integer");
}

// node_modules/typebox/build/type/types/literal.mjs
var InvalidLiteralValue = class extends Error {
  constructor(value) {
    super(`Invalid Literal value`);
    Object.defineProperty(this, "cause", {
      value: { value },
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
};
function LiteralTypeName(value) {
  return guard_exports.IsBigInt(value) ? "bigint" : guard_exports.IsBoolean(value) ? "boolean" : guard_exports.IsNumber(value) ? "number" : guard_exports.IsString(value) ? "string" : (() => {
    throw new InvalidLiteralValue(value);
  })();
}
function Literal(value, options) {
  return memory_exports.Create({ "~kind": "Literal" }, { type: LiteralTypeName(value), const: value }, options);
}
function IsLiteralValue(value) {
  return guard_exports.IsBigInt(value) || guard_exports.IsBoolean(value) || guard_exports.IsNumber(value) || guard_exports.IsString(value);
}
function IsLiteralNumber(value) {
  return IsLiteral(value) && guard_exports.IsNumber(value.const);
}
function IsLiteralString(value) {
  return IsLiteral(value) && guard_exports.IsString(value.const);
}
function IsLiteral(value) {
  return IsKind(value, "Literal");
}

// node_modules/typebox/build/type/types/null.mjs
function Null(options) {
  return memory_exports.Create({ "~kind": "Null" }, { type: "null" }, options);
}
function IsNull2(value) {
  return IsKind(value, "Null");
}

// node_modules/typebox/build/type/types/number.mjs
var NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
function Number2(options) {
  return memory_exports.Create({ "~kind": "Number" }, { type: "number" }, options);
}
function IsNumber3(value) {
  return IsKind(value, "Number");
}

// node_modules/typebox/build/type/types/symbol.mjs
function Symbol2(options) {
  return memory_exports.Create({ "~kind": "Symbol" }, { type: "symbol" }, options);
}
function IsSymbol2(value) {
  return IsKind(value, "Symbol");
}

// node_modules/typebox/build/type/types/parameter.mjs
function Parameter(...args) {
  const [name, extends_, equals] = arguments_exports.Match(args, {
    3: (name2, extends_2, equals2) => [name2, extends_2, equals2],
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ "~kind": "Parameter" }, { name, extends: extends_, equals }, {});
}
function IsParameter(value) {
  return IsKind(value, "Parameter");
}

// node_modules/typebox/build/type/types/string.mjs
var StringPattern = ".*";
function String2(options) {
  return memory_exports.Create({ "~kind": "String" }, { type: "string" }, options);
}
function IsString3(value) {
  return IsKind(value, "String");
}

// node_modules/typebox/build/type/types/union.mjs
function Union(anyOf, options = {}) {
  return memory_exports.Create({ "~kind": "Union" }, { anyOf }, options);
}
function IsUnion(value) {
  return IsKind(value, "Union");
}
function UnionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "anyOf"]);
}

// node_modules/typebox/build/type/engine/patterns/pattern.mjs
function ParsePatternIntoTypes(pattern) {
  const parsed = Pattern(pattern);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : [];
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/is_finite.mjs
function FromLiteral(_value) {
  return true;
}
function FromTypesReduce(types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType(left) ? FromTypesReduce(right) : false, () => true);
}
function FromTypes(types) {
  const result = guard_exports.IsEqual(types.length, 0) ? false : FromTypesReduce(types);
  return result;
}
function FromType(type) {
  return IsUnion(type) ? FromTypes(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : false;
}
function IsTemplateLiteralFinite(types) {
  const result = FromTypes(types);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/create.mjs
function TemplateLiteralCreate(pattern) {
  return memory_exports.Create({ ["~kind"]: "TemplateLiteral" }, { type: "string", pattern }, {});
}

// node_modules/typebox/build/type/engine/template_literal/decode.mjs
function FromLiteralPush(variants, value, result = []) {
  return guard_exports.ShiftLeft(variants, (left, right) => FromLiteralPush(right, value, [...result, `${left}${value}`]), () => result);
}
function FromLiteral2(variants, value) {
  return guard_exports.IsEqual(variants.length, 0) ? [`${value}`] : FromLiteralPush(variants, value);
}
function FromUnion(variants, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => FromUnion(variants, right, [...result, ...FromType2(variants, left)]), () => result);
}
function FromType2(variants, type) {
  const result = IsUnion(type) ? FromUnion(variants, type.anyOf) : IsLiteral(type) ? FromLiteral2(variants, type.const) : Unreachable();
  return result;
}
function DecodeFromSpan(variants, types) {
  return guard_exports.ShiftLeft(types, (left, right) => DecodeFromSpan(FromType2(variants, left), right), () => variants);
}
function VariantsToLiterals(variants) {
  return variants.map((variant) => Literal(variant));
}
function DecodeTypesAsUnion(types) {
  const variants = DecodeFromSpan([], types);
  const literals = VariantsToLiterals(variants);
  const result = Union(literals);
  return result;
}
function DecodeTypes(types) {
  return guard_exports.IsEqual(types.length, 0) ? Unreachable() : (
    // Literal('') :
    guard_exports.IsEqual(types.length, 1) && IsLiteral(types[0]) ? types[0] : DecodeTypesAsUnion(types)
  );
}
function TemplateLiteralDecodeUnsafe(pattern) {
  const types = ParsePatternIntoTypes(pattern);
  const result = guard_exports.IsEqual(types.length, 0) ? String2() : IsTemplateLiteralFinite(types) ? DecodeTypes(types) : TemplateLiteralCreate(pattern);
  return result;
}
function TemplateLiteralDecode(pattern) {
  const decoded = TemplateLiteralDecodeUnsafe(pattern);
  const result = IsTemplateLiteral(decoded) ? String2() : decoded;
  return result;
}

// node_modules/typebox/build/type/engine/record/record_create.mjs
function CreateRecord(key, value) {
  const type = "object";
  const patternProperties = { [key]: value };
  return memory_exports.Create({ ["~kind"]: "Record" }, { type, patternProperties });
}

// node_modules/typebox/build/type/engine/record/from_key_any.mjs
function FromAnyKey(value) {
  return CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_boolean.mjs
function FromBooleanKey(value) {
  return _Object_({ true: value, false: value });
}

// node_modules/typebox/build/type/types/tuple.mjs
function Tuple(types, options = {}) {
  const [items, minItems, additionalItems] = [types, types.length, false];
  return memory_exports.Create({ ["~kind"]: "Tuple" }, { type: "array", additionalItems, items, minItems }, options);
}
function IsTuple(value) {
  return IsKind(value, "Tuple");
}
function TupleOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items", "minItems", "additionalItems"]);
}

// node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs
function RemoveReadonlyOperation(type) {
  return memory_exports.Discard(type, ["~readonly"]);
}
function RemoveReadonlyAction(type, options) {
  const result = memory_exports.Update(RemoveReadonlyOperation(type), {}, options);
  return result;
}
function RemoveReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_readonly.mjs
function RemoveReadonlyDeferred(type, options = {}) {
  return Deferred("RemoveReadonly", [type], options);
}
function RemoveReadonly(type, options = {}) {
  return RemoveReadonlyAction(type, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs
function RemoveOptionalOperation(type) {
  return memory_exports.Discard(type, ["~optional"]);
}
function RemoveOptionalAction(type, options) {
  const result = memory_exports.Update(RemoveOptionalOperation(type), {}, options);
  return result;
}
function RemoveOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_optional.mjs
function RemoveOptionalDeferred(type, options = {}) {
  return Deferred("RemoveOptional", [type], options);
}
function RemoveOptional(type, options = {}) {
  return RemoveOptionalAction(type, options);
}

// node_modules/typebox/build/type/engine/tuple/to_object.mjs
function TupleElementsToProperties(types) {
  const result = types.reduceRight((result2, right, index) => {
    return { [index]: right, ...result2 };
  }, {});
  return result;
}
function TupleToObject(type) {
  const properties = TupleElementsToProperties(type.items);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/composite.mjs
function IsReadonlyProperty(left, right) {
  return IsReadonly(left) ? IsReadonly(right) ? true : false : false;
}
function IsOptionalProperty(left, right) {
  return IsOptional(left) ? IsOptional(right) ? true : false : false;
}
function CompositeProperty(left, right) {
  const isReadonly = IsReadonlyProperty(left, right);
  const isOptional = IsOptionalProperty(left, right);
  const evaluated = EvaluateIntersect([left, right]);
  const property = RemoveReadonly(RemoveOptional(evaluated));
  return isReadonly && isOptional ? AddReadonly(AddOptional(property)) : isReadonly && !isOptional ? AddReadonly(property) : !isReadonly && isOptional ? AddOptional(property) : property;
}
function CompositePropertyKey(left, right, key) {
  return key in left ? key in right ? CompositeProperty(left[key], right[key]) : left[key] : key in right ? right[key] : Never();
}
function CompositeProperties(left, right) {
  const keys = /* @__PURE__ */ new Set([...guard_exports.Keys(right), ...guard_exports.Keys(left)]);
  return [...keys].reduce((result, key) => {
    return { ...result, [key]: CompositePropertyKey(left, right, key) };
  }, {});
}
function GetProperties(type) {
  const result = IsObject2(type) ? type.properties : IsTuple(type) ? TupleElementsToProperties(type.items) : Unreachable();
  return result;
}
function Composite(left, right) {
  const leftProperties = GetProperties(left);
  const rightProperties = GetProperties(right);
  const properties = CompositeProperties(leftProperties, rightProperties);
  return _Object_(properties);
}

// node_modules/typebox/build/type/engine/evaluate/narrow.mjs
function Narrow(left, right) {
  const result = Compare(left, right);
  return guard_exports.IsEqual(result, ResultLeftInside) ? left : guard_exports.IsEqual(result, ResultRightInside) ? right : guard_exports.IsEqual(result, ResultEqual) ? right : Never();
}

// node_modules/typebox/build/type/engine/evaluate/distribute.mjs
function IsObjectLike(type) {
  return IsObject2(type) || IsTuple(type);
}
function IsUnionOperand(left, right) {
  const isUnionLeft = IsUnion(left);
  const isUnionRight = IsUnion(right);
  const result = isUnionLeft || isUnionRight;
  return result;
}
function DistributeOperation(left, right) {
  const evaluatedLeft = EvaluateType(left);
  const evaluatedRight = EvaluateType(right);
  const isUnionOperand = IsUnionOperand(evaluatedLeft, evaluatedRight);
  const isObjectLeft = IsObjectLike(evaluatedLeft);
  const IsObjectRight = IsObjectLike(evaluatedRight);
  const result = isUnionOperand ? EvaluateIntersect([evaluatedLeft, evaluatedRight]) : isObjectLeft && IsObjectRight ? Composite(evaluatedLeft, evaluatedRight) : isObjectLeft && !IsObjectRight ? evaluatedLeft : !isObjectLeft && IsObjectRight ? evaluatedRight : Narrow(evaluatedLeft, evaluatedRight);
  return result;
}
function DistributeType(type, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeType(type, right, [...result, DistributeOperation(type, left)]), () => guard_exports.IsEqual(result.length, 0) ? [type] : result);
}
function DistributeUnion(types, distribution, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeUnion(right, distribution, [...result, ...Distribute([left], distribution)]), () => result);
}
function Distribute(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => IsUnion(left) ? Distribute(right, DistributeUnion(left.anyOf, result)) : Distribute(right, DistributeType(left, result)), () => result);
}

// node_modules/typebox/build/type/engine/exclude/operation.mjs
function ExcludeType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [] : [left];
  return result;
}
function ExcludeUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExcludeType(head, right)];
  }, []);
}
function ExcludeOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExcludeUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/evaluate.mjs
function EvaluateDependent(if_, then_, else_) {
  const intersect = Intersect([if_, then_]);
  const excluded = ExcludeOperation(else_, if_);
  const result = EvaluateUnion([intersect, excluded]);
  return result;
}
function EvaluateEnum(values) {
  const result = values.map((value) => Literal(value));
  return EvaluateUnion(result);
}
function EvaluateIntersect(types) {
  const distribution = Distribute(types);
  const broadend = Broaden(distribution);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateTemplateLiteral(pattern) {
  const evaluated = TemplateLiteralDecode(pattern);
  const result = EvaluateType(evaluated);
  return result;
}
function EvaluateUnion(types) {
  const broadend = Broaden(types);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateType(type) {
  return IsDependent(type) ? EvaluateDependent(type.if, type.then, type.else) : IsEnum(type) ? EvaluateEnum(type.enum) : IsIntersect(type) ? EvaluateIntersect(type.allOf) : IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsUnion(type) ? EvaluateUnion(type.anyOf) : type;
}
function EvaluateUnionFast(types) {
  const result = guard_exports.IsEqual(types.length, 1) ? types[0] : guard_exports.IsEqual(types.length, 0) ? Never() : Union(types);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_enum.mjs
function FromEnumKey(values, value) {
  const unionKey = EvaluateEnum(values);
  const result = FromKey(unionKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_integer.mjs
function FromIntegerKey(_key, value) {
  const result = CreateRecord(IntegerKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_intersect.mjs
function FromIntersectKey(types, value) {
  const evaluatedKey = EvaluateIntersect(types);
  const result = FromKey(evaluatedKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_literal.mjs
function FromLiteralKey(key, value) {
  return guard_exports.IsString(key) || guard_exports.IsNumber(key) ? _Object_({ [key]: value }) : guard_exports.IsEqual(key, false) ? _Object_({ false: value }) : guard_exports.IsEqual(key, true) ? _Object_({ true: value }) : _Object_({});
}

// node_modules/typebox/build/type/engine/record/from_key_number.mjs
function FromNumberKey(_key, value) {
  const result = CreateRecord(NumberKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_string.mjs
function FromStringKey(key, value) {
  return guard_exports.HasPropertyKey(key, "pattern") && (guard_exports.IsString(key.pattern) || key.pattern instanceof RegExp) ? CreateRecord(key.pattern.toString(), value) : CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs
function FromTemplateKey(pattern, value) {
  const types = ParsePatternIntoTypes(pattern);
  const finite = IsTemplateLiteralFinite(types);
  const result = finite ? FromKey(EvaluateTemplateLiteral(pattern), value) : CreateRecord(pattern, value);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/flatten.mjs
function FlattenType(type) {
  const result = IsUnion(type) ? Flatten(type.anyOf) : [type];
  return result;
}
function Flatten(types) {
  return types.reduce((result, type) => {
    return [...result, ...FlattenType(type)];
  }, []);
}

// node_modules/typebox/build/type/engine/record/from_key_union.mjs
function StringOrNumberCheck(types) {
  return types.some((type) => IsString3(type) || IsNumber3(type) || IsInteger2(type));
}
function TryBuildRecord(types, value) {
  return guard_exports.IsEqual(StringOrNumberCheck(types), true) ? CreateRecord(StringKey, value) : void 0;
}
function CreateProperties(types, value) {
  return types.reduce((result, left) => {
    return IsLiteral(left) && (guard_exports.IsString(left.const) || guard_exports.IsNumber(left.const)) ? { ...result, [left.const]: value } : result;
  }, {});
}
function CreateObject(types, value) {
  const properties = CreateProperties(types, value);
  const result = _Object_(properties);
  return result;
}
function FromUnionKey(types, value) {
  const flattened = Flatten(types);
  const record = TryBuildRecord(flattened, value);
  return IsSchema(record) ? record : CreateObject(flattened, value);
}

// node_modules/typebox/build/type/engine/record/from_key.mjs
function FromKey(key, value) {
  const result = IsAny(key) ? FromAnyKey(value) : IsBoolean3(key) ? FromBooleanKey(value) : IsEnum(key) ? FromEnumKey(key.enum, value) : IsInteger2(key) ? FromIntegerKey(key, value) : IsIntersect(key) ? FromIntersectKey(key.allOf, value) : IsLiteral(key) ? FromLiteralKey(key.const, value) : IsNumber3(key) ? FromNumberKey(key, value) : IsUnion(key) ? FromUnionKey(key.anyOf, value) : IsString3(key) ? FromStringKey(key, value) : IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) : _Object_({});
  return result;
}

// node_modules/typebox/build/type/engine/record/instantiate.mjs
function RecordAction(key, value, options) {
  const result = CanInstantiate([key]) ? memory_exports.Update(FromKey(key, value), {}, options) : RecordDeferred(key, value, options);
  return result;
}
function RecordInstantiate(context, state, key, value, options) {
  const instantiatedKey = InstantiateType(context, state, key);
  const instantiatedValue = InstantiateType(context, state, value);
  return RecordAction(instantiatedKey, instantiatedValue, options);
}

// node_modules/typebox/build/type/types/record.mjs
var IntegerKey = `^${IntegerPattern}$`;
var NumberKey = `^${NumberPattern}$`;
var StringKey = `^${StringPattern}$`;
function RecordDeferred(key, value, options = {}) {
  return Deferred("Record", [key, value], options);
}
function Record(key, value, options = {}) {
  return RecordAction(key, value, options);
}
function RecordFromPattern(pattern, value) {
  return CreateRecord(pattern, value);
}
function RecordPatternToType(pattern) {
  const result = guard_exports.IsEqual(pattern, StringKey) ? String2() : guard_exports.IsEqual(pattern, IntegerKey) ? Integer() : guard_exports.IsEqual(pattern, NumberKey) ? Number2() : TemplateLiteralDecodeUnsafe(pattern);
  return result;
}
function RecordPattern(type) {
  return guard_exports.Keys(type.patternProperties)[0];
}
function RecordKey(type) {
  const pattern = RecordPattern(type);
  const result = RecordPatternToType(pattern);
  return result;
}
function RecordValue(type) {
  return type.patternProperties[RecordPattern(type)];
}
function IsRecord(value) {
  return IsKind(value, "Record");
}

// node_modules/typebox/build/type/types/rest.mjs
function Rest(type) {
  return memory_exports.Create({ "~kind": "Rest" }, { type: "rest", items: type }, {});
}
function IsRest(value) {
  return IsKind(value, "Rest");
}

// node_modules/typebox/build/type/types/this.mjs
function This(options) {
  return memory_exports.Create({ ["~kind"]: "This" }, { $ref: "#" }, options);
}
function IsThis(value) {
  return IsKind(value, "This");
}

// node_modules/typebox/build/type/types/undefined.mjs
function Undefined(options) {
  return memory_exports.Create({ "~kind": "Undefined" }, { type: "undefined" }, options);
}
function IsUndefined2(value) {
  return IsKind(value, "Undefined");
}

// node_modules/typebox/build/type/types/void.mjs
function Void(options) {
  return memory_exports.Create({ "~kind": "Void" }, { type: "void" }, options);
}
function IsVoid(value) {
  return IsKind(value, "Void");
}

// node_modules/typebox/build/type/script/mapping.mjs
function IntrinsicOrCall(ref, parameters) {
  return guard_exports.IsEqual(ref, "Array") ? _Array_(parameters[0]) : guard_exports.IsEqual(ref, "Capitalize") ? CapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ConstructorParameters") ? ConstructorParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Evaluate") ? EvaluateDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Exclude") ? ExcludeDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Extract") ? ExtractDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Index") ? IndexDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "InstanceType") ? InstanceTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Lowercase") ? LowercaseDeferred(parameters[0]) : guard_exports.IsEqual(ref, "NonNullable") ? NonNullableDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Omit") ? OmitDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Parameters") ? ParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Partial") ? PartialDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Pick") ? PickDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Readonly") ? ReadonlyObjectDeferred(parameters[0]) : guard_exports.IsEqual(ref, "KeyOf") ? KeyOfDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Record") ? RecordDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Required") ? RequiredDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ReturnType") ? ReturnTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uncapitalize") ? UncapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uppercase") ? UppercaseDeferred(parameters[0]) : CallConstruct(Ref(ref), parameters);
}
function Unreachable2() {
  throw Error("Unreachable");
}
function DelimitedDecode(input, result = []) {
  return guard_exports.ShiftLeft(input, (left, right) => DelimitedDecode(right, [...result, left[1]]), () => result);
}
function Delimited(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], ...DelimitedDecode(input[1])] : [];
}
function GenericParameterExtendsEqualsMapping(input) {
  return Parameter(input[0], input[2], input[4]);
}
function GenericParameterExtendsMapping(input) {
  return Parameter(input[0], input[2], input[2]);
}
function GenericParameterEqualsMapping(input) {
  return Parameter(input[0], Unknown(), input[2]);
}
function GenericParameterIdentifierMapping(input) {
  return Parameter(input, Unknown(), Unknown());
}
function GenericParameterMapping(input) {
  return input;
}
function GenericParameterListMapping(input) {
  return Delimited(input);
}
function GenericParametersMapping(input) {
  return input[1];
}
function GenericCallArgumentListMapping(input) {
  return Delimited(input);
}
function GenericCallArgumentsMapping(input) {
  return input[1];
}
function GenericCallMapping(input) {
  return IntrinsicOrCall(input[0], input[1]);
}
function OptionalSemiColonMapping(input) {
  return null;
}
function KeywordStringMapping(input) {
  return String2();
}
function KeywordNumberMapping(input) {
  return Number2();
}
function KeywordBooleanMapping(input) {
  return Boolean2();
}
function KeywordUndefinedMapping(input) {
  return Undefined();
}
function KeywordNullMapping(input) {
  return Null();
}
function KeywordIntegerMapping(input) {
  return Integer();
}
function KeywordBigIntMapping(input) {
  return BigInt2();
}
function KeywordUnknownMapping(input) {
  return Unknown();
}
function KeywordAnyMapping(input) {
  return Any();
}
function KeywordObjectMapping(input) {
  return _Object_({});
}
function KeywordNeverMapping(input) {
  return Never();
}
function KeywordSymbolMapping(input) {
  return Symbol2();
}
function KeywordVoidMapping(input) {
  return Void();
}
function KeywordThisMapping(input) {
  return This();
}
function LiteralBigIntMapping(input) {
  return Literal(BigInt(input));
}
function LiteralBooleanMapping(input) {
  return Literal(guard_exports.IsEqual(input, "true"));
}
function LiteralNumberMapping(input) {
  return Literal(parseFloat(input));
}
function LiteralStringMapping(input) {
  return Literal(input);
}
function TemplateInterpolateMapping(input) {
  return input[1];
}
function TemplateSpanMapping(input) {
  return Literal(input);
}
function TemplateBodyMapping(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], input[1], ...input[2]] : [input[0]];
}
function TemplateLiteralTypesMapping(input) {
  return input[1];
}
function TemplateLiteralMapping(input) {
  return TemplateLiteralDeferred(input);
}
function DependentMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? Dependent(input[1], input[3], input[5]) : Dependent(input[1], input[3], Unknown());
}
function KeyOfMapping(input) {
  return input.length > 0;
}
function IndexArrayMapping(input) {
  return input.reduce((result, current) => {
    return guard_exports.IsEqual(current.length, 3) ? [...result, [current[1]]] : [...result, []];
  }, []);
}
function ExtendsMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? [input[1], input[3], input[5]] : [];
}
function BaseMapping(input) {
  return guard_exports.IsArray(input) && guard_exports.IsEqual(input.length, 3) ? input[1] : input;
}
function WithMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function FactorIndexArray(Type2, indexArray) {
  return indexArray.reduce((result, left) => {
    const _left = left;
    return guard_exports.IsEqual(_left.length, 1) ? IndexDeferred(result, _left[0]) : guard_exports.IsEqual(_left.length, 0) ? _Array_(result) : Unreachable2();
  }, Type2);
}
function FactorExtends(type, extend) {
  return guard_exports.IsEqual(extend.length, 3) ? ConditionalDeferred(type, extend[0], extend[1], extend[2]) : type;
}
function FactorWith(type, withClause) {
  return guard_exports.IsArray(withClause) && guard_exports.IsEqual(withClause.length, 0) ? type : WithDeferred(type, withClause);
}
function FactorMapping(input) {
  const [keyOf, type, indexArray, extend, withClause] = input;
  return FactorWith(keyOf ? FactorExtends(KeyOfDeferred(FactorIndexArray(type, indexArray)), extend) : FactorExtends(FactorIndexArray(type, indexArray), extend), withClause);
}
function ExprBinaryMapping(left, rest) {
  return guard_exports.IsEqual(rest.length, 3) ? (() => {
    const [operator, right, next] = rest;
    const Schema = ExprBinaryMapping(right, next);
    if (guard_exports.IsEqual(operator, "&")) {
      return IsIntersect(Schema) ? Intersect([left, ...Schema.allOf]) : Intersect([left, Schema]);
    }
    if (guard_exports.IsEqual(operator, "|")) {
      return IsUnion(Schema) ? Union([left, ...Schema.anyOf]) : Union([left, Schema]);
    }
    Unreachable2();
  })() : left;
}
function ExprTermTailMapping(input) {
  return input;
}
function ExprTermMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprTailMapping(input) {
  return input;
}
function ExprMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprReadonlyMapping(input) {
  return AddImmutableDeferred(input[1]);
}
function ExprPipeMapping(input) {
  return input[1];
}
function GenericTypeMapping(input) {
  return Generic(input[0], input[2]);
}
function InferTypeMapping(input) {
  return guard_exports.IsEqual(input.length, 4) ? Infer(input[1], input[3]) : guard_exports.IsEqual(input.length, 2) ? Infer(input[1], Unknown()) : Unreachable2();
}
function TypeMapping(input) {
  return input;
}
function PropertyKeyNumberMapping(input) {
  return `${input}`;
}
function PropertyKeyIdentMapping(input) {
  return input;
}
function PropertyKeyQuotedMapping(input) {
  return input;
}
function PropertyKeyIndexMapping(input) {
  return IsInteger2(input[3]) ? IntegerKey : IsNumber3(input[3]) ? NumberKey : IsSymbol2(input[3]) ? StringKey : IsString3(input[3]) ? StringKey : Unreachable2();
}
function PropertyKeyMapping(input) {
  return input;
}
function ReadonlyMapping(input) {
  return input.length > 0;
}
function OptionalMapping(input) {
  return input.length > 0;
}
function PropertyMapping(input) {
  const [isReadonly, key, isOptional, _colon, type] = input;
  return {
    [key]: isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type
  };
}
function PropertyDelimiterMapping(input) {
  return input;
}
function PropertyListMapping(input) {
  return Delimited(input);
}
function PropertiesReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    const isPatternProperties = guard_exports.HasPropertyKey(left, IntegerKey) || guard_exports.HasPropertyKey(left, NumberKey) || guard_exports.HasPropertyKey(left, StringKey);
    return isPatternProperties ? [result[0], memory_exports.Assign(result[1], left)] : [memory_exports.Assign(result[0], left), result[1]];
  }, [{}, {}]);
}
function PropertiesMapping(input) {
  return PropertiesReduce(input[1]);
}
function _Object_Mapping(input) {
  const [properties, patternProperties] = input;
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return _Object_(properties, options);
}
function ElementNamedMapping(input) {
  return guard_exports.IsEqual(input.length, 5) ? AddReadonlyDeferred(AddOptionalDeferred(input[4])) : guard_exports.IsEqual(input.length, 3) ? input[2] : guard_exports.IsEqual(input.length, 4) ? guard_exports.IsEqual(input[2], "readonly") ? AddReadonlyDeferred(input[3]) : AddOptionalDeferred(input[3]) : Unreachable2();
}
function ElementBaseMapping(input) {
  if (!guard_exports.IsArray(input) || !guard_exports.IsEqual(input.length, 3))
    return input;
  const [isReadonly, type, isOptional] = input;
  return isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type;
}
function ElementMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ElementListMapping(input) {
  return Delimited(input);
}
function _Tuple_Mapping(input) {
  return Tuple(input[1]);
}
function ParameterReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[4]));
}
function ParameterReadonlyMapping(input) {
  return AddReadonlyDeferred(input[3]);
}
function ParameterOptionalMapping(input) {
  return AddOptionalDeferred(input[3]);
}
function ParameterTypeMapping(input) {
  return input[2];
}
function ParameterBaseMapping(input) {
  return input;
}
function ParameterMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ParameterListMapping(input) {
  return Delimited(input);
}
function _Function_Mapping(input) {
  return _Function_(input[1], input[4]);
}
function _Constructor_Mapping(input) {
  return Constructor(input[2], input[5]);
}
function ApplyReadonly(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveReadonlyDeferred(type) : guard_exports.IsEqual(state, "add") ? AddReadonlyDeferred(type) : type;
}
function MappedReadonlyMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function ApplyOptional(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveOptionalDeferred(type) : guard_exports.IsEqual(state, "add") ? AddOptionalDeferred(type) : type;
}
function MappedOptionalMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function MappedAsMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? [input[1]] : [];
}
function _Mapped_Mapping(input) {
  return guard_exports.IsArray(input[6]) && guard_exports.IsEqual(input[6].length, 1) ? MappedDeferred(Identifier(input[3]), input[5], input[6][0], ApplyReadonly(input[1], ApplyOptional(input[8], input[10]))) : MappedDeferred(Identifier(input[3]), input[5], Ref(input[3]), ApplyReadonly(input[1], ApplyOptional(input[8], input[10])));
}
function ReferenceMapping(input) {
  return Ref(input);
}
function WithBigIntMapping(input) {
  return BigInt(input);
}
function WithNumberMapping(input) {
  return parseFloat(input);
}
function WithBooleanMapping(input) {
  return guard_exports.IsEqual(input, "true");
}
function WithStringMapping(input) {
  return input;
}
function WithNullMapping(input) {
  return null;
}
function WithUndefinedMapping(input) {
  return void 0;
}
function WithPropertyMapping(input) {
  return { [input[0]]: input[2] };
}
function WithPropertyListMapping(input) {
  return Delimited(input);
}
function WithObjectMappingReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    return memory_exports.Assign(result, left);
  }, {});
}
function WithObjectMapping(input) {
  return WithObjectMappingReduce(input[1]);
}
function WithElementListMapping(input) {
  return Delimited(input);
}
function WithArrayMapping(input) {
  return input[1];
}
function WithValueMapping(input) {
  return input;
}
function PatternBigIntMapping(input) {
  return BigInt2();
}
function PatternStringMapping(input) {
  return String2();
}
function PatternNumberMapping(input) {
  return Number2();
}
function PatternIntegerMapping(input) {
  return Integer();
}
function PatternNeverMapping(input) {
  return Never();
}
function PatternTextMapping(input) {
  return Literal(input);
}
function PatternBaseMapping(input) {
  return input;
}
function PatternGroupMapping(input) {
  return Union(input[1]);
}
function PatternUnionMapping(input) {
  return input.length === 3 ? [...input[0], ...input[2]] : input.length === 1 ? [...input[0]] : [];
}
function PatternTermMapping(input) {
  return [input[0], ...input[1]];
}
function PatternBodyMapping(input) {
  return input;
}
function PatternMapping(input) {
  return input[1];
}
function InterfaceDeclarationHeritageListMapping(input) {
  return Delimited(input);
}
function InterfaceDeclarationHeritageMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function InterfaceDeclarationGenericMapping(input) {
  const parameters = input[2];
  const heritage = input[3];
  const [properties, patternProperties] = input[4];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: Generic(parameters, InterfaceDeferred(heritage, properties, options)) };
}
function InterfaceDeclarationMapping(input) {
  const heritage = input[2];
  const [properties, patternProperties] = input[3];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: InterfaceDeferred(heritage, properties, options) };
}
function TypeAliasDeclarationGenericMapping(input) {
  return { [input[1]]: Generic(input[2], input[4]) };
}
function TypeAliasDeclarationMapping(input) {
  return { [input[1]]: input[3] };
}
function ExportKeywordMapping(input) {
  return null;
}
function ModuleDeclarationDelimiterMapping(input) {
  return input;
}
function ModuleDeclarationListMapping(input) {
  return Delimited(input);
}
function ModuleDeclarationMapping(input) {
  return input[1];
}
function ModuleMapping(input) {
  const [moduleDeclaration, moduleDeclarationList] = [input[0], input[1]];
  return ModuleDeferred(memory_exports.Assign(moduleDeclaration, PropertiesReduce(moduleDeclarationList)[0]));
}
function ScriptMapping(input) {
  return input;
}

// node_modules/typebox/build/type/script/token/internal/match.mjs
function IsMatch(value) {
  return IsEqual(value.length, 2);
}
function Match2(input, ok, fail) {
  return IsMatch(input) ? ok(input[0], input[1]) : fail();
}

// node_modules/typebox/build/type/script/token/internal/take.mjs
function TakeVariant(variant, input) {
  return IsEqual(input.indexOf(variant), 0) ? [variant, input.slice(variant.length)] : [];
}
function Take(variants, input) {
  for (let i = 0; i < variants.length; i++) {
    const result = TakeVariant(variants[i], input);
    if (IsMatch(result))
      return result;
  }
  return [];
}

// node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha = [
  ...Range(97, 122),
  // Lowercase
  ...Range(65, 90)
  // Uppercase
];
var Zero = "0";
var NonZero = Range(49, 57);
var Digit = [Zero, ...NonZero];
var WhiteSpace = " ";
var NewLine = "\n";
var UnderScore = "_";
var Dot = ".";
var DollarSign = "$";
var Hyphen = "-";

// node_modules/typebox/build/type/script/token/internal/trim.mjs
var LineComment = "//";
var OpenComment = "/*";
var CloseComment = "*/";
function DiscardMultilineComment(input) {
  const index = input.indexOf(CloseComment);
  const result = IsEqual(index, -1) ? "" : input.slice(index + 2);
  return result;
}
function DiscardLineComment(input) {
  const index = input.indexOf(NewLine);
  const result = IsEqual(index, -1) ? "" : input.slice(index);
  return result;
}
function TrimStartUntilNewline(input) {
  return input.replace(/^[ \t\r\f\v]+/, "");
}
function TrimWhitespace(input) {
  const trimmed = TrimStartUntilNewline(input);
  return trimmed.startsWith(OpenComment) ? TrimWhitespace(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? TrimWhitespace(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
function Trim(input) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(OpenComment) ? Trim(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? Trim(DiscardLineComment(trimmed.slice(2))) : trimmed;
}

// node_modules/typebox/build/type/script/token/internal/optional.mjs
function Optional2(value, input) {
  return Match2(Take([value], input), (Optional4, Rest2) => [Optional4, Rest2], () => ["", input]);
}

// node_modules/typebox/build/type/script/token/internal/many.mjs
function IsDiscard(discard, input) {
  return discard.includes(input);
}
function Many(allowed, discard, input, result = "") {
  return Match2(Take(allowed, input), (Char, Rest2) => IsDiscard(discard, Char) ? Many(allowed, discard, Rest2, result) : Many(allowed, discard, Rest2, `${result}${Char}`), () => [result, input]);
}

// node_modules/typebox/build/type/script/token/unsigned_integer.mjs
function TakeNonZero(input) {
  return Take(NonZero, input);
}
var AllowedDigits = [...Digit, UnderScore];
function TakeDigits(input) {
  return Many(AllowedDigits, [UnderScore], input);
}
function TakeUnsignedInteger(input) {
  return Match2(Take([Zero], input), (Zero2, ZeroRest) => [Zero2, ZeroRest], () => Match2(
    TakeNonZero(input),
    (NonZero2, NonZeroRest) => Match2(TakeDigits(NonZeroRest), (Digits, DigitsRest) => [`${NonZero2}${Digits}`, DigitsRest], () => []),
    // fail: did not match Digits
    () => []
  ));
}
function UnsignedInteger(input) {
  return TakeUnsignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/integer.mjs
function TakeSign(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedInteger(input) {
  return Match2(
    TakeSign(input),
    (Sign, SignRest) => Match2(UnsignedInteger(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Integer2(input) {
  return TakeSignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/bigint.mjs
function TakeBigInt(input) {
  return Match2(
    Integer2(input),
    (Integer3, IntegerRest) => Match2(Take(["n"], IntegerRest), (_N, NRest) => [`${Integer3}`, NRest], () => []),
    // fail: did not match 'n'
    () => []
  );
}
function BigInt3(input) {
  return TakeBigInt(input);
}

// node_modules/typebox/build/type/script/token/const.mjs
function TakeConst(const_, input) {
  return Take([const_], input);
}
function Const(const_, input) {
  return IsEqual(const_, "") ? ["", input] : const_.startsWith(NewLine) ? TakeConst(const_, TrimWhitespace(input)) : const_.startsWith(WhiteSpace) ? TakeConst(const_, input) : TakeConst(const_, Trim(input));
}

// node_modules/typebox/build/type/script/token/ident.mjs
var Initial = [...Alpha, UnderScore, DollarSign];
function TakeInitial(input) {
  return Take(Initial, input);
}
var Remaining = [...Initial, ...Digit];
function TakeRemaining(input, result = "") {
  return Match2(Take(Remaining, input), (Remaining2, RemainingRest) => TakeRemaining(RemainingRest, `${result}${Remaining2}`), () => [result, input]);
}
function TakeIdent(input) {
  return Match2(
    TakeInitial(input),
    (Initial2, InitialRest) => Match2(TakeRemaining(InitialRest), (Remaining2, RemainingRest) => [`${Initial2}${Remaining2}`, RemainingRest], () => []),
    // fail: did not match Remaining
    () => []
  );
}
function Ident(input) {
  return TakeIdent(Trim(input));
}

// node_modules/typebox/build/type/script/token/unsigned_number.mjs
var AllowedDigits2 = [...Digit, UnderScore];
function IsLeadingDot(input) {
  return IsMatch(Take([Dot], input));
}
function TakeFractional(input) {
  return Match2(Many(AllowedDigits2, [UnderScore], input), (Digits, DigitsRest) => IsEqual(Digits, "") ? [] : [Digits, DigitsRest], () => []);
}
function LeadingDot(input) {
  return Match2(
    Take([Dot], input),
    (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`0${Dot2}${Fractional}`, FractionalRest], () => []),
    // fail: did not match Fractional
    () => []
  );
}
function LeadingInteger(input) {
  return Match2(
    UnsignedInteger(input),
    (Integer3, IntegerRest) => Match2(
      Take([Dot], IntegerRest),
      (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`${Integer3}${Dot2}${Fractional}`, FractionalRest], () => [`${Integer3}`, DotRest]),
      // fail: did not match Fractional, use Integer
      () => [`${Integer3}`, IntegerRest]
    ),
    // fail: did not match Dot, use Integer
    () => []
  );
}
function TakeUnsignedNumber(input) {
  return IsLeadingDot(input) ? LeadingDot(input) : LeadingInteger(input);
}
function UnsignedNumber(input) {
  return TakeUnsignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/number.mjs
function TakeSign2(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedNumber(input) {
  return Match2(
    TakeSign2(input),
    (Sign, SignRest) => Match2(UnsignedNumber(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Number3(input) {
  return TakeSignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/until.mjs
function TakeOne(input) {
  const result = IsEqual(input, "") ? [] : [input.slice(0, 1), input.slice(1)];
  return result;
}
function IsInputMatchSentinal(end, input) {
  return ShiftLeft(end, (left, right) => input.startsWith(left) ? true : IsInputMatchSentinal(right, input), () => false);
}
function Until(end, input, result = "") {
  return Match2(
    TakeOne(input),
    (One, Rest2) => IsInputMatchSentinal(end, input) ? [result, input] : Until(end, Rest2, `${result}${One}`),
    () => []
  );
}

// node_modules/typebox/build/type/script/token/span.mjs
function MultiLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, Rest3) => [`${Until2}`, Rest3], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function SingleLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([NewLine, end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, EndRest) => [`${Until2}`, EndRest], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function Span(start, end, multiLine, input) {
  return multiLine ? MultiLine(start, end, Trim(input)) : SingleLine(start, end, Trim(input));
}

// node_modules/typebox/build/type/script/token/string.mjs
function TakeInitial2(quotes, input) {
  return Take(quotes, input);
}
function TakeSpan(quote, input) {
  return Span(quote, quote, false, input);
}
function TakeString(quotes, input) {
  return Match2(TakeInitial2(quotes, input), (Initial2, InitialRest) => TakeSpan(Initial2, `${Initial2}${InitialRest}`), () => []);
}
function String3(quotes, input) {
  return TakeString(quotes, Trim(input));
}

// node_modules/typebox/build/type/script/token/until_1.mjs
function Until_1(end, input) {
  return Match2(Until(end, input), (Until2, UntilRest) => IsEqual(Until2, "") ? [] : [Until2, UntilRest], () => []);
}

// node_modules/typebox/build/type/script/parser.mjs
var If = (result, left, right = () => []) => result.length === 2 ? left(result) : right();
var GenericParameterExtendsEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [GenericParameterExtendsEqualsMapping(_0), input2]);
var GenericParameterExtends = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterExtendsMapping(_0), input2]);
var GenericParameterEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterEqualsMapping(_0), input2]);
var GenericParameterIdentifier = (input) => If(Ident(input), ([_0, input2]) => [GenericParameterIdentifierMapping(_0), input2]);
var GenericParameter = (input) => If(If(GenericParameterExtendsEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterExtends(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterIdentifier(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [GenericParameterMapping(_0), input2]);
var GenericParameterList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(GenericParameter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericParameterList_0(input2, [...result, _0]), () => [result, input]);
var GenericParameterList = (input) => If(If(If(GenericParameter(input), ([_0, input2]) => If(GenericParameterList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [GenericParameterListMapping(_0), input2]);
var GenericParameters = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericParameterList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParametersMapping(_0), input2]);
var GenericCallArgumentList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericCallArgumentList_0(input2, [...result, _0]), () => [result, input]);
var GenericCallArgumentList = (input) => If(If(If(Type(input), ([_0, input2]) => If(GenericCallArgumentList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [GenericCallArgumentListMapping(_0), input2]);
var GenericCallArguments = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericCallArgumentList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericCallArgumentsMapping(_0), input2]);
var GenericCall = (input) => If(If(Ident(input), ([_0, input2]) => If(GenericCallArguments(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallMapping(_0), input2]);
var OptionalSemiColon = (input) => If(If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalSemiColonMapping(_0), input2]);
var KeywordString = (input) => If(Const("string", input), ([_0, input2]) => [KeywordStringMapping(_0), input2]);
var KeywordNumber = (input) => If(Const("number", input), ([_0, input2]) => [KeywordNumberMapping(_0), input2]);
var KeywordBoolean = (input) => If(Const("boolean", input), ([_0, input2]) => [KeywordBooleanMapping(_0), input2]);
var KeywordUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [KeywordUndefinedMapping(_0), input2]);
var KeywordNull = (input) => If(Const("null", input), ([_0, input2]) => [KeywordNullMapping(_0), input2]);
var KeywordInteger = (input) => If(Const("integer", input), ([_0, input2]) => [KeywordIntegerMapping(_0), input2]);
var KeywordBigInt = (input) => If(Const("bigint", input), ([_0, input2]) => [KeywordBigIntMapping(_0), input2]);
var KeywordUnknown = (input) => If(Const("unknown", input), ([_0, input2]) => [KeywordUnknownMapping(_0), input2]);
var KeywordAny = (input) => If(Const("any", input), ([_0, input2]) => [KeywordAnyMapping(_0), input2]);
var KeywordObject = (input) => If(Const("object", input), ([_0, input2]) => [KeywordObjectMapping(_0), input2]);
var KeywordNever = (input) => If(Const("never", input), ([_0, input2]) => [KeywordNeverMapping(_0), input2]);
var KeywordSymbol = (input) => If(Const("symbol", input), ([_0, input2]) => [KeywordSymbolMapping(_0), input2]);
var KeywordVoid = (input) => If(Const("void", input), ([_0, input2]) => [KeywordVoidMapping(_0), input2]);
var KeywordThis = (input) => If(Const("this", input), ([_0, input2]) => [KeywordThisMapping(_0), input2]);
var TemplateInterpolate = (input) => If(If(Const("${", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateInterpolateMapping(_0), input2]);
var TemplateSpan = (input) => If(Until(["${", "`"], input), ([_0, input2]) => [TemplateSpanMapping(_0), input2]);
var TemplateBody = (input) => If(If(If(TemplateSpan(input), ([_0, input2]) => If(TemplateInterpolate(input2), ([_1, input3]) => If(TemplateBody(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [TemplateBodyMapping(_0), input2]);
var TemplateLiteralTypes = (input) => If(If(Const("`", input), ([_0, input2]) => If(TemplateBody(input2), ([_1, input3]) => If(Const("`", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateLiteralTypesMapping(_0), input2]);
var TemplateLiteral = (input) => If(TemplateLiteralTypes(input), ([_0, input2]) => [TemplateLiteralMapping(_0), input2]);
var Dependent2 = (input) => If(If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const("else", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [DependentMapping(_0), input2]);
var LiteralBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [LiteralBigIntMapping(_0), input2]);
var LiteralBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [LiteralBooleanMapping(_0), input2]);
var LiteralNumber = (input) => If(Number3(input), ([_0, input2]) => [LiteralNumberMapping(_0), input2]);
var LiteralString = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [LiteralStringMapping(_0), input2]);
var KeyOf = (input) => If(If(If(Const("keyof", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [KeyOfMapping(_0), input2]);
var IndexArray_0 = (input, result = []) => If(If(If(Const("[", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(Const("[", input), ([_0, input2]) => If(Const("]", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => IndexArray_0(input2, [...result, _0]), () => [result, input]);
var IndexArray = (input) => If(IndexArray_0(input), ([_0, input2]) => [IndexArrayMapping(_0), input2]);
var Extends2 = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const(":", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExtendsMapping(_0), input2]);
var Base = (input) => If(If(If(Const("(", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(KeywordString(input), ([_0, input2]) => [_0, input2], () => If(KeywordNumber(input), ([_0, input2]) => [_0, input2], () => If(KeywordBoolean(input), ([_0, input2]) => [_0, input2], () => If(KeywordUndefined(input), ([_0, input2]) => [_0, input2], () => If(KeywordNull(input), ([_0, input2]) => [_0, input2], () => If(KeywordInteger(input), ([_0, input2]) => [_0, input2], () => If(KeywordBigInt(input), ([_0, input2]) => [_0, input2], () => If(KeywordUnknown(input), ([_0, input2]) => [_0, input2], () => If(KeywordAny(input), ([_0, input2]) => [_0, input2], () => If(KeywordObject(input), ([_0, input2]) => [_0, input2], () => If(KeywordNever(input), ([_0, input2]) => [_0, input2], () => If(KeywordSymbol(input), ([_0, input2]) => [_0, input2], () => If(KeywordVoid(input), ([_0, input2]) => [_0, input2], () => If(KeywordThis(input), ([_0, input2]) => [_0, input2], () => If(LiteralBigInt(input), ([_0, input2]) => [_0, input2], () => If(LiteralBoolean(input), ([_0, input2]) => [_0, input2], () => If(LiteralNumber(input), ([_0, input2]) => [_0, input2], () => If(LiteralString(input), ([_0, input2]) => [_0, input2], () => If(TemplateLiteral(input), ([_0, input2]) => [_0, input2], () => If(Dependent2(input), ([_0, input2]) => [_0, input2], () => If(_Object_2(input), ([_0, input2]) => [_0, input2], () => If(_Tuple_(input), ([_0, input2]) => [_0, input2], () => If(_Constructor_(input), ([_0, input2]) => [_0, input2], () => If(_Function_2(input), ([_0, input2]) => [_0, input2], () => If(_Mapped_(input), ([_0, input2]) => [_0, input2], () => If(GenericCall(input), ([_0, input2]) => [_0, input2], () => If(Reference(input), ([_0, input2]) => [_0, input2], () => [])))))))))))))))))))))))))))), ([_0, input2]) => [BaseMapping(_0), input2]);
var With = (input) => If(If(If(Const("with", input), ([_0, input2]) => If(WithObject(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithMapping(_0), input2]);
var Factor = (input) => If(If(KeyOf(input), ([_0, input2]) => If(Base(input2), ([_1, input3]) => If(IndexArray(input3), ([_2, input4]) => If(Extends2(input4), ([_3, input5]) => If(With(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [FactorMapping(_0), input2]);
var ExprTermTail = (input) => If(If(If(Const("&", input), ([_0, input2]) => If(Factor(input2), ([_1, input3]) => If(ExprTermTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTermTailMapping(_0), input2]);
var ExprTerm = (input) => If(If(Factor(input), ([_0, input2]) => If(ExprTermTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprTermMapping(_0), input2]);
var ExprTail = (input) => If(If(If(Const("|", input), ([_0, input2]) => If(ExprTerm(input2), ([_1, input3]) => If(ExprTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTailMapping(_0), input2]);
var Expr = (input) => If(If(ExprTerm(input), ([_0, input2]) => If(ExprTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprMapping(_0), input2]);
var ExprReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprReadonlyMapping(_0), input2]);
var ExprPipe = (input) => If(If(Const("|", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprPipeMapping(_0), input2]);
var GenericType = (input) => If(If(GenericParameters(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericTypeMapping(_0), input2]);
var InferType = (input) => If(If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("extends", input3), ([_2, input4]) => If(Expr(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InferTypeMapping(_0), input2]);
var Type = (input) => If(If(InferType(input), ([_0, input2]) => [_0, input2], () => If(ExprPipe(input), ([_0, input2]) => [_0, input2], () => If(ExprReadonly(input), ([_0, input2]) => [_0, input2], () => If(Expr(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [TypeMapping(_0), input2]);
var PropertyKeyNumber = (input) => If(Number3(input), ([_0, input2]) => [PropertyKeyNumberMapping(_0), input2]);
var PropertyKeyIdent = (input) => If(Ident(input), ([_0, input2]) => [PropertyKeyIdentMapping(_0), input2]);
var PropertyKeyQuoted = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [PropertyKeyQuotedMapping(_0), input2]);
var PropertyKeyIndex = (input) => If(If(Const("[", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(If(KeywordInteger(input4), ([_02, input5]) => [_02, input5], () => If(KeywordNumber(input4), ([_02, input5]) => [_02, input5], () => If(KeywordString(input4), ([_02, input5]) => [_02, input5], () => If(KeywordSymbol(input4), ([_02, input5]) => [_02, input5], () => [])))), ([_3, input5]) => If(Const("]", input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyKeyIndexMapping(_0), input2]);
var PropertyKey = (input) => If(If(PropertyKeyNumber(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIdent(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyQuoted(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIndex(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [PropertyKeyMapping(_0), input2]);
var Readonly2 = (input) => If(If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ReadonlyMapping(_0), input2]);
var Optional3 = (input) => If(If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalMapping(_0), input2]);
var Property = (input) => If(If(Readonly2(input), ([_0, input2]) => If(PropertyKey(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => If(Const(":", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyMapping(_0), input2]);
var PropertyDelimiter = (input) => If(If(If(Const(",", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(",", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [PropertyDelimiterMapping(_0), input2]);
var PropertyList_0 = (input, result = []) => If(If(PropertyDelimiter(input), ([_0, input2]) => If(Property(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => PropertyList_0(input2, [...result, _0]), () => [result, input]);
var PropertyList = (input) => If(If(If(Property(input), ([_0, input2]) => If(PropertyList_0(input2), ([_1, input3]) => If(If(PropertyDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PropertyListMapping(_0), input2]);
var Properties = (input) => If(If(Const("{", input), ([_0, input2]) => If(PropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PropertiesMapping(_0), input2]);
var _Object_2 = (input) => If(Properties(input), ([_0, input2]) => [_Object_Mapping(_0), input2]);
var ElementNamed = (input) => If(If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ElementNamedMapping(_0), input2]);
var ElementBase = (input) => If(If(ElementNamed(input), ([_0, input2]) => [_0, input2], () => If(If(Readonly2(input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementBaseMapping(_0), input2]);
var Element = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ElementBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ElementBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementMapping(_0), input2]);
var ElementList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Element(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ElementList_0(input2, [...result, _0]), () => [result, input]);
var ElementList = (input) => If(If(If(Element(input), ([_0, input2]) => If(ElementList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementListMapping(_0), input2]);
var _Tuple_ = (input) => If(If(Const("[", input), ([_0, input2]) => If(ElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_Tuple_Mapping(_0), input2]);
var ParameterReadonlyOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [ParameterReadonlyOptionalMapping(_0), input2]);
var ParameterReadonly = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterReadonlyMapping(_0), input2]);
var ParameterOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterOptionalMapping(_0), input2]);
var ParameterType = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ParameterTypeMapping(_0), input2]);
var ParameterBase = (input) => If(If(ParameterReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterReadonly(input), ([_0, input2]) => [_0, input2], () => If(ParameterOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterType(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ParameterBaseMapping(_0), input2]);
var Parameter2 = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ParameterBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ParameterBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterMapping(_0), input2]);
var ParameterList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Parameter2(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ParameterList_0(input2, [...result, _0]), () => [result, input]);
var ParameterList = (input) => If(If(If(Parameter2(input), ([_0, input2]) => If(ParameterList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterListMapping(_0), input2]);
var _Function_2 = (input) => If(If(Const("(", input), ([_0, input2]) => If(ParameterList(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => If(Const("=>", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_Function_Mapping(_0), input2]);
var _Constructor_ = (input) => If(If(Const("new", input), ([_0, input2]) => If(Const("(", input2), ([_1, input3]) => If(ParameterList(input3), ([_2, input4]) => If(Const(")", input4), ([_3, input5]) => If(Const("=>", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_Constructor_Mapping(_0), input2]);
var MappedReadonly = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedReadonlyMapping(_0), input2]);
var MappedOptional = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedOptionalMapping(_0), input2]);
var MappedAs = (input) => If(If(If(Const("as", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [MappedAsMapping(_0), input2]);
var _Mapped_ = (input) => If(If(Const("{", input), ([_0, input2]) => If(MappedReadonly(input2), ([_1, input3]) => If(Const("[", input3), ([_2, input4]) => If(Ident(input4), ([_3, input5]) => If(Const("in", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => If(MappedAs(input7), ([_6, input8]) => If(Const("]", input8), ([_7, input9]) => If(MappedOptional(input9), ([_8, input10]) => If(Const(":", input10), ([_9, input11]) => If(Type(input11), ([_10, input12]) => If(OptionalSemiColon(input12), ([_11, input13]) => If(Const("}", input13), ([_12, input14]) => [[_0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12], input14]))))))))))))), ([_0, input2]) => [_Mapped_Mapping(_0), input2]);
var Reference = (input) => If(Ident(input), ([_0, input2]) => [ReferenceMapping(_0), input2]);
var WithBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [WithBigIntMapping(_0), input2]);
var WithNumber = (input) => If(Number3(input), ([_0, input2]) => [WithNumberMapping(_0), input2]);
var WithBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithBooleanMapping(_0), input2]);
var WithString = (input) => If(String3(['"', "'"], input), ([_0, input2]) => [WithStringMapping(_0), input2]);
var WithNull = (input) => If(Const("null", input), ([_0, input2]) => [WithNullMapping(_0), input2]);
var WithUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [WithUndefinedMapping(_0), input2]);
var WithProperty = (input) => If(If(PropertyKey(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(WithValue(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithPropertyMapping(_0), input2]);
var WithPropertyList_0 = (input, result = []) => If(If(PropertyDelimiter(input), ([_0, input2]) => If(WithProperty(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithPropertyList_0(input2, [...result, _0]), () => [result, input]);
var WithPropertyList = (input) => If(If(If(WithProperty(input), ([_0, input2]) => If(WithPropertyList_0(input2), ([_1, input3]) => If(If(PropertyDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithPropertyListMapping(_0), input2]);
var WithObject = (input) => If(If(Const("{", input), ([_0, input2]) => If(WithPropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithObjectMapping(_0), input2]);
var WithElementList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(WithValue(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithElementList_0(input2, [...result, _0]), () => [result, input]);
var WithElementList = (input) => If(If(If(WithValue(input), ([_0, input2]) => If(WithElementList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithElementListMapping(_0), input2]);
var WithArray = (input) => If(If(Const("[", input), ([_0, input2]) => If(WithElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithArrayMapping(_0), input2]);
var WithValue = (input) => If(If(WithBigInt(input), ([_0, input2]) => [_0, input2], () => If(WithNumber(input), ([_0, input2]) => [_0, input2], () => If(WithBoolean(input), ([_0, input2]) => [_0, input2], () => If(WithString(input), ([_0, input2]) => [_0, input2], () => If(WithNull(input), ([_0, input2]) => [_0, input2], () => If(WithUndefined(input), ([_0, input2]) => [_0, input2], () => If(WithObject(input), ([_0, input2]) => [_0, input2], () => If(WithArray(input), ([_0, input2]) => [_0, input2], () => [])))))))), ([_0, input2]) => [WithValueMapping(_0), input2]);
var PatternBigInt = (input) => If(Const("-?(?:0|[1-9][0-9]*)n", input), ([_0, input2]) => [PatternBigIntMapping(_0), input2]);
var PatternString = (input) => If(Const(".*", input), ([_0, input2]) => [PatternStringMapping(_0), input2]);
var PatternNumber = (input) => If(Const("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", input), ([_0, input2]) => [PatternNumberMapping(_0), input2]);
var PatternInteger = (input) => If(Const("-?(?:0|[1-9][0-9]*)", input), ([_0, input2]) => [PatternIntegerMapping(_0), input2]);
var PatternNever = (input) => If(Const("(?!)", input), ([_0, input2]) => [PatternNeverMapping(_0), input2]);
var PatternText = (input) => If(Until_1(["-?(?:0|[1-9][0-9]*)n", ".*", "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", "-?(?:0|[1-9][0-9]*)", "(?!)", "(", ")", "$", "|"], input), ([_0, input2]) => [PatternTextMapping(_0), input2]);
var PatternBase = (input) => If(If(PatternBigInt(input), ([_0, input2]) => [_0, input2], () => If(PatternString(input), ([_0, input2]) => [_0, input2], () => If(PatternNumber(input), ([_0, input2]) => [_0, input2], () => If(PatternInteger(input), ([_0, input2]) => [_0, input2], () => If(PatternNever(input), ([_0, input2]) => [_0, input2], () => If(PatternGroup(input), ([_0, input2]) => [_0, input2], () => If(PatternText(input), ([_0, input2]) => [_0, input2], () => []))))))), ([_0, input2]) => [PatternBaseMapping(_0), input2]);
var PatternGroup = (input) => If(If(Const("(", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternGroupMapping(_0), input2]);
var PatternUnion = (input) => If(If(If(PatternTerm(input), ([_0, input2]) => If(Const("|", input2), ([_1, input3]) => If(PatternUnion(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(PatternTerm(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [PatternUnionMapping(_0), input2]);
var PatternTerm = (input) => If(If(PatternBase(input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PatternTermMapping(_0), input2]);
var PatternBody = (input) => If(If(PatternUnion(input), ([_0, input2]) => [_0, input2], () => If(PatternTerm(input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PatternBodyMapping(_0), input2]);
var Pattern = (input) => If(If(Const("^", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const("$", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternMapping(_0), input2]);
var InterfaceDeclarationHeritageList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => InterfaceDeclarationHeritageList_0(input2, [...result, _0]), () => [result, input]);
var InterfaceDeclarationHeritageList = (input) => If(If(If(Type(input), ([_0, input2]) => If(InterfaceDeclarationHeritageList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageListMapping(_0), input2]);
var InterfaceDeclarationHeritage = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(InterfaceDeclarationHeritageList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageMapping(_0), input2]);
var InterfaceDeclarationGeneric = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(InterfaceDeclarationHeritage(input4), ([_3, input5]) => If(Properties(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [InterfaceDeclarationGenericMapping(_0), input2]);
var InterfaceDeclaration = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(InterfaceDeclarationHeritage(input3), ([_2, input4]) => If(Properties(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [InterfaceDeclarationMapping(_0), input2]);
var TypeAliasDeclarationGeneric = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [TypeAliasDeclarationGenericMapping(_0), input2]);
var TypeAliasDeclaration = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("=", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [TypeAliasDeclarationMapping(_0), input2]);
var ExportKeyword = (input) => If(If(If(Const("export", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExportKeywordMapping(_0), input2]);
var ModuleDeclarationDelimiter = (input) => If(If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ModuleDeclarationDelimiterMapping(_0), input2]);
var ModuleDeclarationList_0 = (input, result = []) => If(If(ModuleDeclarationDelimiter(input), ([_0, input2]) => If(ModuleDeclaration(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ModuleDeclarationList_0(input2, [...result, _0]), () => [result, input]);
var ModuleDeclarationList = (input) => If(If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList_0(input2), ([_1, input3]) => If(If(ModuleDeclarationDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ModuleDeclarationListMapping(_0), input2]);
var ModuleDeclaration = (input) => If(If(ExportKeyword(input), ([_0, input2]) => If(If(InterfaceDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(InterfaceDeclaration(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclaration(input2), ([_02, input3]) => [_02, input3], () => [])))), ([_1, input3]) => If(OptionalSemiColon(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ModuleDeclarationMapping(_0), input2]);
var Module = (input) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleMapping(_0), input2]);
var Script = (input) => If(If(Module(input), ([_0, input2]) => [_0, input2], () => If(GenericType(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ScriptMapping(_0), input2]);

// node_modules/typebox/build/type/engine/patterns/template.mjs
function ParseTemplateIntoTypes(template) {
  const parsed = TemplateLiteralTypes(`\`${template}\``);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/encode.mjs
function JoinString(input) {
  return input.join("|");
}
function UnwrapTemplateLiteralPattern(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function EncodeLiteral(value, right, pattern) {
  return EncodeTypes(right, `${pattern}${value}`);
}
function EncodeBigInt(right, pattern) {
  return EncodeTypes(right, `${pattern}${BigIntPattern}`);
}
function EncodeInteger(right, pattern) {
  return EncodeTypes(right, `${pattern}${IntegerPattern}`);
}
function EncodeNumber(right, pattern) {
  return EncodeTypes(right, `${pattern}${NumberPattern}`);
}
function EncodeBoolean(right, pattern) {
  return EncodeType(Union([Literal("false"), Literal("true")]), right, pattern);
}
function EncodeString(right, pattern) {
  return EncodeTypes(right, `${pattern}${StringPattern}`);
}
function EncodeTemplateLiteral(templatePattern, right, pattern) {
  return EncodeTypes(right, `${pattern}${UnwrapTemplateLiteralPattern(templatePattern)}`);
}
function EncodeTemplateLiteralDeferred(types, right, pattern) {
  const templateLiteral = TemplateLiteralAction(types, {});
  const result = EncodeType(templateLiteral, right, pattern);
  return result;
}
function EncodeEnum(values, right, pattern) {
  const evaluated = EvaluateEnum(values);
  return EncodeType(evaluated, right, pattern);
}
function EncodeUnion(types, right, pattern, result = []) {
  return guard_exports.ShiftLeft(types, (head, tail) => EncodeUnion(tail, right, pattern, [...result, EncodeType(head, [], "")]), () => EncodeTypes(right, `${pattern}(${JoinString(result)})`));
}
function EncodeType(type, right, pattern) {
  return IsEnum(type) ? EncodeEnum(type.enum, right, pattern) : IsInteger2(type) ? EncodeInteger(right, pattern) : IsLiteral(type) ? EncodeLiteral(type.const, right, pattern) : IsBigInt2(type) ? EncodeBigInt(right, pattern) : IsBoolean3(type) ? EncodeBoolean(right, pattern) : IsNumber3(type) ? EncodeNumber(right, pattern) : IsString3(type) ? EncodeString(right, pattern) : IsTemplateLiteral(type) ? EncodeTemplateLiteral(type.pattern, right, pattern) : IsTemplateLiteralDeferred(type) ? EncodeTemplateLiteralDeferred(type.parameters[0], right, pattern) : IsUnion(type) ? EncodeUnion(type.anyOf, right, pattern) : NeverPattern;
}
function EncodeTypes(types, pattern) {
  return guard_exports.ShiftLeft(types, (left, right) => EncodeType(left, right, pattern), () => pattern);
}
function EncodePattern(types) {
  const encoded = EncodeTypes(types, "");
  const result = `^${encoded}$`;
  return result;
}
function TemplateLiteralEncode(types) {
  const pattern = EncodePattern(types);
  const result = TemplateLiteralCreate(pattern);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/instantiate.mjs
function TemplateLiteralAction(types, options) {
  const result = CanInstantiate(types) ? memory_exports.Update(TemplateLiteralEncode(types), {}, options) : TemplateLiteralDeferred(types, options);
  return result;
}
function TemplateLiteralInstantiate(context, state, types, options) {
  const instantiatedTypes = InstantiateTypes(context, state, types);
  return TemplateLiteralAction(instantiatedTypes, options);
}

// node_modules/typebox/build/type/types/template_literal.mjs
function TemplateLiteralDeferred(types, options = {}) {
  return Deferred("TemplateLiteral", [types], options);
}
function IsTemplateLiteralDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "TemplateLiteral");
}
function TemplateLiteralFromTypes(types) {
  return TemplateLiteralAction(types, {});
}
function TemplateLiteralFromString(template) {
  const types = ParseTemplateIntoTypes(template);
  return TemplateLiteralFromTypes(types);
}
function TemplateLiteral2(input, options = {}) {
  const type = guard_exports.IsString(input) ? TemplateLiteralFromString(input) : TemplateLiteralFromTypes(input);
  return memory_exports.Update(type, {}, options);
}
function IsTemplateLiteral(value) {
  return IsKind(value, "TemplateLiteral");
}

// node_modules/typebox/build/type/extends/result.mjs
var result_exports = {};
__export(result_exports, {
  ExtendsFalse: () => ExtendsFalse,
  ExtendsTrue: () => ExtendsTrue,
  ExtendsUnion: () => ExtendsUnion,
  IsExtendsFalse: () => IsExtendsFalse,
  IsExtendsTrue: () => IsExtendsTrue,
  IsExtendsTrueLike: () => IsExtendsTrueLike,
  IsExtendsUnion: () => IsExtendsUnion,
  Match: () => Match3
});
function ExtendsUnion(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsUnion" }, { inferred });
}
function IsExtendsUnion(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsUnion") && guard_exports.IsObject(value.inferred);
}
function ExtendsTrue(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsTrue" }, { inferred });
}
function IsExtendsTrue(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsTrue") && guard_exports.IsObject(value.inferred);
}
function ExtendsFalse() {
  return memory_exports.Create({ ["~kind"]: "ExtendsFalse" }, {});
}
function IsExtendsFalse(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], "ExtendsFalse");
}
function IsExtendsTrueLike(value) {
  return IsExtendsUnion(value) || IsExtendsTrue(value);
}
function Match3(result, true_, false_) {
  return IsExtendsTrueLike(result) ? true_(result.inferred) : false_();
}

// node_modules/typebox/build/type/extends/extends_right.mjs
function ExtendsRightInfer(inferred, name, left, right) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => ExtendsTrue(memory_exports.Assign(memory_exports.Assign(inferred, checkInferred), { [name]: left })), () => ExtendsFalse());
}
function ExtendsRightAny(inferred, _left) {
  return ExtendsTrue(inferred);
}
function ExtendsRightDependent(inferred, left, if_, then_, else_) {
  return Match3(ExtendsLeft(inferred, left, if_), (inferred2) => Match3(ExtendsLeft(inferred2, left, then_), (inferred3) => ExtendsTrue(inferred3), () => ExtendsFalse()), () => Match3(ExtendsLeft(inferred, left, else_), (inferred2) => ExtendsTrue(inferred2), () => ExtendsFalse()));
}
function ExtendsRightEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightIntersect(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsRightIntersect(inferred2, left, tail), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsRightTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightUnion(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsRightUnion(inferred, left, tail)), () => ExtendsFalse());
}
function ExtendsRight(inferred, left, right) {
  return IsAny(right) ? ExtendsRightAny(inferred, left) : IsDependent(right) ? ExtendsRightDependent(inferred, left, right.if, right.then, right.else) : IsEnum(right) ? ExtendsRightEnum(inferred, left, right.enum) : IsInfer(right) ? ExtendsRightInfer(inferred, right.name, left, right.extends) : IsIntersect(right) ? ExtendsRightIntersect(inferred, left, right.allOf) : IsTemplateLiteral(right) ? ExtendsRightTemplateLiteral(inferred, left, right.pattern) : IsUnion(right) ? ExtendsRightUnion(inferred, left, right.anyOf) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/any.mjs
function ExtendsAny(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsUnion(inferred);
}

// node_modules/typebox/build/type/extends/array.mjs
function ExtendsImmutable(left, right) {
  const isImmutableLeft = IsImmutable(left);
  const isImmutableRight = IsImmutable(right);
  return isImmutableLeft && isImmutableRight ? true : !isImmutableLeft && isImmutableRight ? true : isImmutableLeft && !isImmutableRight ? false : true;
}
function ExtendsArray(inferred, arrayLeft, left, right) {
  return IsArray2(right) ? ExtendsImmutable(arrayLeft, right) ? ExtendsLeft(inferred, left, right.items) : ExtendsFalse() : ExtendsRight(inferred, arrayLeft, right);
}

// node_modules/typebox/build/type/extends/bigint.mjs
function ExtendsBigInt(inferred, left, right) {
  return IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/boolean.mjs
function ExtendsBoolean(inferred, left, right) {
  return IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/parameters.mjs
function ParameterCompare(inferred, left, leftRest, right, rightRest) {
  const checkLeft = IsInfer(right) ? left : right;
  const checkRight = IsInfer(right) ? right : left;
  const isLeftOptional = IsOptional(left);
  const isRightOptional = IsOptional(right);
  return !isLeftOptional && isRightOptional ? ExtendsFalse() : Match3(ExtendsLeft(inferred, checkLeft, checkRight), (inferred2) => ExtendsParameters(inferred2, leftRest, rightRest), () => ExtendsFalse());
}
function ParameterRight(inferred, left, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ParameterCompare(inferred, left, leftRest, head, tail), () => IsOptional(left) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function ParametersLeft(inferred, left, rightRest) {
  return guard_exports.ShiftLeft(left, (head, tail) => ParameterRight(inferred, head, tail, rightRest), () => ExtendsTrue(inferred));
}
function ExtendsParameters(inferred, left, right) {
  return ParametersLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/return_type.mjs
function ExtendsReturnType(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/constructor.mjs
function ExtendsConstructor(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsConstructor2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["instanceType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/dependent.mjs
function ExtendsDependent(inferred, if_, then_, else_, right) {
  return Match3(ExtendsLeft(inferred, if_, right), () => ExtendsLeft(inferred, then_, right), () => ExtendsLeft(inferred, else_, right));
}

// node_modules/typebox/build/type/extends/enum.mjs
function ExtendsEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/function.mjs
function ExtendsFunction(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsFunction2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["returnType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/integer.mjs
function ExtendsInteger(inferred, left, right) {
  return IsInteger2(right) ? ExtendsTrue(inferred) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/intersect.mjs
function ExtendsIntersect(inferred, left, right) {
  const evaluated = EvaluateIntersect(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/literal.mjs
function ExtendsLiteralValue(inferred, left, right) {
  return left === right ? ExtendsTrue(inferred) : ExtendsFalse();
}
function ExtendsLiteralBigInt(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralBoolean(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralNumber(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralString(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteral(inferred, left, right) {
  return guard_exports.IsBigInt(left.const) ? ExtendsLiteralBigInt(inferred, left.const, right) : guard_exports.IsBoolean(left.const) ? ExtendsLiteralBoolean(inferred, left.const, right) : guard_exports.IsNumber(left.const) ? ExtendsLiteralNumber(inferred, left.const, right) : guard_exports.IsString(left.const) ? ExtendsLiteralString(inferred, left.const, right) : Unreachable();
}

// node_modules/typebox/build/type/extends/never.mjs
function ExtendsNever(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : ExtendsTrue(inferred);
}

// node_modules/typebox/build/type/extends/null.mjs
function ExtendsNull(inferred, left, right) {
  return IsNull2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/number.mjs
function ExtendsNumber(inferred, left, right) {
  return IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/object.mjs
function ExtendsPropertyOptional(inferred, left, right) {
  return IsOptional(left) ? IsOptional(right) ? ExtendsTrue(inferred) : ExtendsFalse() : ExtendsTrue(inferred);
}
function ExtendsProperty(inferred, left, right) {
  return (
    // Right TInfer<TNever> is TExtendsFalse
    IsInfer(right) && IsNever(right.extends) ? ExtendsFalse() : Match3(ExtendsLeft(inferred, left, right), (inferred2) => ExtendsPropertyOptional(inferred2, left, right), () => ExtendsFalse())
  );
}
function ExtractInferredProperties(keys, properties) {
  return keys.reduce((result, key) => {
    return key in properties ? IsExtendsTrueLike(properties[key]) ? { ...result, ...properties[key].inferred } : Unreachable() : Unreachable();
  }, {});
}
function ExtendsPropertiesComparer(inferred, left, right) {
  const properties = {};
  for (const rightKey of guard_exports.Keys(right)) {
    properties[rightKey] = rightKey in left ? ExtendsProperty({}, left[rightKey], right[rightKey]) : IsOptional(right[rightKey]) ? IsInfer(right[rightKey]) ? ExtendsTrue(memory_exports.Assign(inferred, { [right[rightKey].name]: right[rightKey].extends })) : ExtendsTrue(inferred) : ExtendsFalse();
  }
  const checked = guard_exports.Values(properties).every((result) => IsExtendsTrueLike(result));
  const extracted = checked ? ExtractInferredProperties(guard_exports.Keys(properties), properties) : {};
  return checked ? ExtendsTrue(extracted) : ExtendsFalse();
}
function ExtendsProperties(inferred, left, right) {
  const compared = ExtendsPropertiesComparer(inferred, left, right);
  return IsExtendsTrueLike(compared) ? ExtendsTrue(memory_exports.Assign(inferred, compared.inferred)) : ExtendsFalse();
}
function ExtendsObjectToObject(inferred, left, right) {
  return ExtendsProperties(inferred, left, right);
}
function RecordMergeInferred(left, right) {
  return guard_exports.Keys(right).reduce((result, key) => {
    return {
      ...result,
      [key]: guard_exports.HasPropertyKey(left, key) ? IsUnion(result[key]) ? Union([...result[key].anyOf, right[key]]) : Union([left[key], right[key]]) : right[key]
    };
  }, left);
}
function ExtendsRecordComparer(properties, keys, type, result) {
  return guard_exports.ShiftLeft(keys, (left, right) => Match3(ExtendsLeft({}, properties[left], type), (inferred) => ExtendsRecordComparer(properties, right, type, RecordMergeInferred(result, inferred)), () => ExtendsFalse()), () => ExtendsTrue(result));
}
function ExtendsObjectToRecord(inferred, properties, _pattern, value) {
  const keys = guard_exports.Keys(properties);
  const result = ExtendsRecordComparer(properties, keys, value, inferred);
  return result;
}
function ExtendsObject(inferred, left, right) {
  return IsRecord(right) ? ExtendsObjectToRecord(inferred, left, RecordPattern(right), RecordValue(right)) : IsObject2(right) ? ExtendsObjectToObject(inferred, left, right.properties) : ExtendsRight(inferred, _Object_(left), right);
}

// node_modules/typebox/build/type/extends/record.mjs
function FromObject2(inferred, properties) {
  return guard_exports.IsEqual(guard_exports.Keys(properties).length, 0) ? ExtendsTrue(inferred) : ExtendsFalse();
}
function FromRecord(inferred, _leftKey, leftValue, _rightKey, rightValue) {
  return ExtendsLeft(inferred, leftValue, rightValue);
}
function ExtendsRecord(inferred, leftPattern, leftValue, right) {
  return IsRecord(right) ? FromRecord(inferred, RecordPatternToType(leftPattern), leftValue, RecordPatternToType(RecordPattern(right)), RecordValue(right)) : IsObject2(right) ? FromObject2(inferred, right.properties) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/string.mjs
function ExtendsString(inferred, left, right) {
  return IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/symbol.mjs
function ExtendsSymbol(inferred, left, right) {
  return IsSymbol2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/template_literal.mjs
function ExtendsTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/inference.mjs
function Inferrable(name, type) {
  return memory_exports.Create({ "~kind": "Inferrable" }, { name, type }, {});
}
function IsInferable(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "name") && guard_exports.HasPropertyKey(value, "type") && guard_exports.IsEqual(value["~kind"], "Inferrable") && guard_exports.IsString(value.name) && guard_exports.IsObject(value.type);
}
function TryRestInferable(type) {
  return IsRest(type) ? IsInfer(type.items) ? IsArray2(type.items.extends) ? Inferrable(type.items.name, type.items.extends.items) : IsUnknown(type.items.extends) ? Inferrable(type.items.name, type.items.extends) : void 0 : Unreachable() : void 0;
}
function TryInferable(type) {
  return IsInfer(type) ? Inferrable(type.name, type.extends) : void 0;
}
function TryInferResults(rest, right, result = []) {
  return guard_exports.ShiftLeft(rest, (head, tail) => Match3(ExtendsLeft({}, head, right), () => TryInferResults(tail, right, [...result, head]), () => void 0), () => result);
}
function InferTupleResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Tuple(results) })) : ExtendsFalse();
}
function InferUnionResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Union(results) })) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/tuple.mjs
function Reverse(types) {
  return [...types].reverse();
}
function ApplyReverse(types, reversed) {
  return reversed ? Reverse(types) : types;
}
function Reversed(types) {
  const first = types.length > 0 ? types[0] : void 0;
  const inferrable = IsSchema(first) ? TryRestInferable(first) : void 0;
  return IsSchema(inferrable);
}
function ElementsCompare(inferred, reversed, left, leftRest, right, rightRest) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => Elements(checkInferred, reversed, leftRest, rightRest), () => ExtendsFalse());
}
function ElementsLeft(inferred, reversed, leftRest, right, rightRest) {
  const inferable = TryRestInferable(right);
  return (
    // Rest Inferrable Right Means we delegate to TInferTupleResult to Generate a Result
    IsInferable(inferable) ? InferTupleResult(inferred, inferable["name"], ApplyReverse(leftRest, reversed), inferable["type"]) : guard_exports.ShiftLeft(leftRest, (head, tail) => ElementsCompare(inferred, reversed, head, tail, right, rightRest), () => ExtendsFalse())
  );
}
function ElementsRight(inferred, reversed, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ElementsLeft(inferred, reversed, leftRest, head, tail), () => guard_exports.IsEqual(leftRest.length, 0) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function Elements(inferred, reversed, leftRest, rightRest) {
  return ElementsRight(inferred, reversed, leftRest, rightRest);
}
function ExtendsTupleToTuple(inferred, left, right) {
  const instantiatedRight = InstantiateElements(inferred, State([], []), right);
  const reversed = Reversed(instantiatedRight);
  return Elements(inferred, reversed, ApplyReverse(left, reversed), ApplyReverse(instantiatedRight, reversed));
}
function ExtendsTupleToArray(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable["name"], left, inferrable["type"]) : guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsLeft(inferred, head, right), (inferred2) => ExtendsTupleToArray(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsTuple(inferred, left, right) {
  const instantiatedLeft = InstantiateElements(inferred, State([], []), left);
  return IsTuple(right) ? ExtendsTupleToTuple(inferred, instantiatedLeft, right.items) : IsArray2(right) ? ExtendsTupleToArray(inferred, instantiatedLeft, right.items) : ExtendsRight(inferred, Tuple(instantiatedLeft), right);
}

// node_modules/typebox/build/type/extends/undefined.mjs
function ExtendsUndefined(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : IsUndefined2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/union.mjs
function ExtendsUnionSome(inferred, type, unionTypes) {
  return guard_exports.ShiftLeft(unionTypes, (head, tail) => Match3(ExtendsLeft(inferred, type, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsUnionSome(inferred, type, tail)), () => ExtendsFalse());
}
function ExtendsUnionLeft(inferred, left, right) {
  return guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsUnionSome(inferred, head, right), (inferred2) => ExtendsUnionLeft(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsUnion2(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable.name, left, inferrable.type) : IsUnion(right) ? ExtendsUnionLeft(inferred, left, right.anyOf) : ExtendsUnionLeft(inferred, left, [right]);
}

// node_modules/typebox/build/type/extends/unknown.mjs
function ExtendsUnknown(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/void.mjs
function ExtendsVoid(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/extends_left.mjs
function ExtendsLeft(inferred, left, right) {
  return IsAny(left) ? ExtendsAny(inferred, left, right) : IsArray2(left) ? ExtendsArray(inferred, left, left.items, right) : IsBigInt2(left) ? ExtendsBigInt(inferred, left, right) : IsBoolean3(left) ? ExtendsBoolean(inferred, left, right) : IsConstructor2(left) ? ExtendsConstructor(inferred, left.parameters, left.instanceType, right) : IsDependent(left) ? ExtendsDependent(inferred, left.if, left.then, left.else, right) : IsEnum(left) ? ExtendsEnum(inferred, left.enum, right) : IsFunction2(left) ? ExtendsFunction(inferred, left.parameters, left.returnType, right) : IsInteger2(left) ? ExtendsInteger(inferred, left, right) : IsIntersect(left) ? ExtendsIntersect(inferred, left.allOf, right) : IsLiteral(left) ? ExtendsLiteral(inferred, left, right) : IsNever(left) ? ExtendsNever(inferred, left, right) : IsNull2(left) ? ExtendsNull(inferred, left, right) : IsNumber3(left) ? ExtendsNumber(inferred, left, right) : IsObject2(left) ? ExtendsObject(inferred, left.properties, right) : IsRecord(left) ? ExtendsRecord(inferred, RecordPattern(left), RecordValue(left), right) : IsString3(left) ? ExtendsString(inferred, left, right) : IsSymbol2(left) ? ExtendsSymbol(inferred, left, right) : IsTemplateLiteral(left) ? ExtendsTemplateLiteral(inferred, left.pattern, right) : IsTuple(left) ? ExtendsTuple(inferred, left.items, right) : IsUndefined2(left) ? ExtendsUndefined(inferred, left, right) : IsUnion(left) ? ExtendsUnion2(inferred, left.anyOf, right) : IsUnknown(left) ? ExtendsUnknown(inferred, left, right) : IsVoid(left) ? ExtendsVoid(inferred, left, right) : ExtendsFalse();
}

// node_modules/typebox/build/type/engine/interface/instantiate.mjs
function InterfaceOperation(heritage, properties) {
  const result = EvaluateIntersect([...heritage, _Object_(properties)]);
  return result;
}
function InterfaceAction(heritage, properties, options) {
  const result = CanInstantiate(heritage) ? memory_exports.Update(InterfaceOperation(heritage, properties), {}, options) : InterfaceDeferred(heritage, properties, options);
  return result;
}
function InterfaceInstantiate(context, state, heritage, properties, options) {
  const instantiatedHeritage = InstantiateTypes(context, state, heritage);
  const instantiatedProperties = InstantiateProperties(context, state, properties);
  return InterfaceAction(instantiatedHeritage, instantiatedProperties, options);
}

// node_modules/typebox/build/type/action/interface.mjs
function InterfaceDeferred(heritage, properties, options = {}) {
  return Deferred("Interface", [heritage, properties], options);
}
function IsInterfaceDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "Interface");
}
function Interface(heritage, properties, options = {}) {
  return InterfaceAction(heritage, properties, options);
}

// node_modules/typebox/build/type/engine/cyclic/check.mjs
function FromRef(stack, context, ref) {
  return stack.includes(ref) ? true : FromType3([...stack, ref], context, context[ref]);
}
function FromProperties(stack, context, properties) {
  const types = PropertyValues(properties);
  return FromTypes2(stack, context, types);
}
function FromTypes2(stack, context, types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType3(stack, context, left) ? true : FromTypes2(stack, context, right), () => false);
}
function FromType3(stack, context, type) {
  return IsRef(type) ? FromRef(stack, context, type.$ref) : IsArray2(type) ? FromType3(stack, context, type.items) : IsConstructor2(type) ? FromTypes2(stack, context, [...type.parameters, type.instanceType]) : IsFunction2(type) ? FromTypes2(stack, context, [...type.parameters, type.returnType]) : IsInterfaceDeferred(type) ? FromProperties(stack, context, type.parameters[1]) : IsIntersect(type) ? FromTypes2(stack, context, type.allOf) : IsObject2(type) ? FromProperties(stack, context, type.properties) : IsUnion(type) ? FromTypes2(stack, context, type.anyOf) : IsTuple(type) ? FromTypes2(stack, context, type.items) : IsRecord(type) ? FromType3(stack, context, RecordValue(type)) : false;
}
function CyclicCheck(stack, context, type) {
  const result = FromType3(stack, context, type);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/candidates.mjs
function ResolveCandidateKeys(context, keys) {
  return keys.reduce((result, left) => {
    return CyclicCheck([left], context, context[left]) ? [...result, left] : result;
  }, []);
}
function CyclicCandidates(context) {
  const keys = PropertyKeys(context);
  const result = ResolveCandidateKeys(context, keys);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/dependencies.mjs
function FromRef2(context, ref, result) {
  return result.includes(ref) ? result : ref in context ? FromType4(context, context[ref], [...result, ref]) : Unreachable();
}
function FromProperties2(context, properties, result) {
  const types = PropertyValues(properties);
  return FromTypes3(context, types, result);
}
function FromTypes3(context, types, result) {
  return types.reduce((result2, left) => {
    return FromType4(context, left, result2);
  }, result);
}
function FromType4(context, type, result) {
  return IsRef(type) ? FromRef2(context, type.$ref, result) : IsArray2(type) ? FromType4(context, type.items, result) : IsConstructor2(type) ? FromTypes3(context, [...type.parameters, type.instanceType], result) : IsFunction2(type) ? FromTypes3(context, [...type.parameters, type.returnType], result) : IsInterfaceDeferred(type) ? FromProperties2(context, type.parameters[1], result) : IsIntersect(type) ? FromTypes3(context, type.allOf, result) : IsObject2(type) ? FromProperties2(context, type.properties, result) : IsUnion(type) ? FromTypes3(context, type.anyOf, result) : IsTuple(type) ? FromTypes3(context, type.items, result) : IsRecord(type) ? FromType4(context, RecordValue(type), result) : result;
}
function CyclicDependencies(context, key, type) {
  const result = FromType4(context, type, [key]);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/extends.mjs
function FromRef3(_ref) {
  return Any();
}
function FromProperties3(properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType5(properties[key]) };
  }, {});
}
function FromTypes4(types) {
  return types.reduce((result, left) => {
    return [...result, FromType5(left)];
  }, []);
}
function FromType5(type) {
  return IsRef(type) ? FromRef3(type.$ref) : IsArray2(type) ? _Array_(FromType5(type.items), ArrayOptions(type)) : IsConstructor2(type) ? Constructor(FromTypes4(type.parameters), FromType5(type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes4(type.parameters), FromType5(type.returnType)) : IsIntersect(type) ? Intersect(FromTypes4(type.allOf)) : IsObject2(type) ? _Object_(FromProperties3(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType5(RecordValue(type))) : IsUnion(type) ? Union(FromTypes4(type.anyOf)) : IsTuple(type) ? Tuple(FromTypes4(type.items)) : type;
}
function CyclicAnyFromParameters(defs, ref) {
  return ref in defs ? FromType5(defs[ref]) : Unknown();
}
function CyclicExtends(type) {
  return CyclicAnyFromParameters(type.$defs, type.$ref);
}

// node_modules/typebox/build/type/engine/cyclic/instantiate.mjs
function CyclicInterface(context, heritage, properties) {
  const instantiatedHeritage = InstantiateTypes(context, State([], []), heritage);
  const instantiatedProperties = InstantiateProperties({}, State([], []), properties);
  const evaluatedInterface = EvaluateIntersect([...instantiatedHeritage, _Object_(instantiatedProperties)]);
  return evaluatedInterface;
}
function CyclicDefinitions(context, dependencies) {
  const keys = guard_exports.Keys(context).filter((key) => dependencies.includes(key));
  return keys.reduce((result, key) => {
    const type = context[key];
    const instantiatedType = IsInterfaceDeferred(type) ? CyclicInterface(context, type.parameters[0], type.parameters[1]) : type;
    return { ...result, [key]: instantiatedType };
  }, {});
}
function InstantiateCyclic(context, ref, type) {
  const dependencies = CyclicDependencies(context, ref, type);
  const definitions = CyclicDefinitions(context, dependencies);
  const result = Cyclic(definitions, ref);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/target.mjs
function Resolve(defs, ref) {
  return ref in defs ? IsRef(defs[ref]) ? Resolve(defs, defs[ref].$ref) : defs[ref] : Never();
}
function CyclicTarget(defs, ref) {
  const result = Resolve(defs, ref);
  return result;
}

// node_modules/typebox/build/type/extends/extends.mjs
function Canonical(type) {
  return IsCyclic(type) ? CyclicExtends(type) : IsUnsafe(type) ? Unknown() : type;
}
function Extends(inferred, left, right) {
  const canonicalLeft = Canonical(left);
  const canonicalRight = Canonical(right);
  return ExtendsLeft(inferred, canonicalLeft, canonicalRight);
}

// node_modules/typebox/build/type/engine/evaluate/compare.mjs
var ResultEqual = "equal";
var ResultDisjoint = "disjoint";
var ResultLeftInside = "left-inside";
var ResultRightInside = "right-inside";
function Compare(left, right) {
  const extendsCheck = [
    IsUnknown(left) ? result_exports.ExtendsFalse() : Extends({}, left, right),
    IsUnknown(left) ? result_exports.ExtendsTrue({}) : Extends({}, right, left)
  ];
  return result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultEqual : result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsFalse(extendsCheck[1]) ? ResultLeftInside : result_exports.IsExtendsFalse(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultRightInside : ResultDisjoint;
}

// node_modules/typebox/build/type/engine/evaluate/broaden.mjs
function BroadFilter(type, types) {
  return types.filter((left) => {
    return Compare(type, left) === ResultRightInside ? false : true;
  });
}
function IsBroadestType(type, types) {
  const result = types.some((left) => {
    const result2 = Compare(type, left);
    return guard_exports.IsEqual(result2, ResultLeftInside) || guard_exports.IsEqual(result2, ResultEqual);
  });
  return guard_exports.IsEqual(result, false);
}
function BroadenType(type, types) {
  const evaluated = EvaluateType(type);
  return IsAny(evaluated) ? [evaluated] : IsBroadestType(evaluated, types) ? [...BroadFilter(evaluated, types), evaluated] : types;
}
function BroadenTypes(types) {
  return types.reduce((result, left) => {
    return IsObject2(left) ? [...result, left] : (
      // push
      IsNever(left) ? result : (
        // ignore
        BroadenType(left, result)
      )
    );
  }, []);
}
function Broaden(types) {
  const broadened = BroadenTypes(types);
  const flattened = Flatten(broadened);
  return flattened;
}

// node_modules/typebox/build/type/engine/evaluate/instantiate.mjs
function EvaluateAction(type, options) {
  const result = memory_exports.Update(EvaluateType(type), {}, options);
  return result;
}
function EvaluateInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return EvaluateAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/call/distribute_arguments.mjs
function CollectDistributionNames(expression, result = []) {
  return (
    // Conditional
    IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? IsRef(expression.parameters[0]) ? CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], [...result, expression.parameters[0]["$ref"]])) : CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], result)) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? IsDeferred(expression.parameters[1]) && guard_exports.IsEqual(expression.parameters[1].action, "KeyOf") && IsRef(expression.parameters[1].parameters[0]) ? [...result, expression.parameters[1].parameters[0]["$ref"]] : result : result
  );
}
function BuildDistributionArray(parameters, names) {
  return parameters.reduce((result, left) => [...result, names.includes(left.name)], []);
}
function ZipDistributionArray(arguments_, distributionArray, result = []) {
  return guard_exports.ShiftLeft(arguments_, (argumentLeft, argumentRight) => guard_exports.ShiftLeft(distributionArray, (booleanLeft, booleanRight) => ZipDistributionArray(argumentRight, booleanRight, [...result, [booleanLeft, argumentLeft]]), () => result), () => result);
}
function CanonicalArgument(type) {
  return IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsEnum(type) ? EvaluateEnum(type.enum) : type;
}
function Expand(type) {
  const canonicalArgument = CanonicalArgument(type);
  return IsUnion(canonicalArgument) ? [...canonicalArgument.anyOf] : [canonicalArgument];
}
function Append(current, type) {
  return current.reduce((result, left) => [...result, [...left, type]], []);
}
function Cross(current, variants) {
  return variants.reduce((result, left) => {
    return [...result, ...Append(current, left)];
  }, []);
}
function Distribute2(zipped) {
  return zipped.reduce((result, left) => {
    return guard_exports.IsEqual(left[0], true) ? Cross(result, Expand(left[1])) : Cross(result, [left[1]]);
  }, [[]]);
}
function DistributeArguments(parameters, arguments_, expression) {
  const distributionNames = CollectDistributionNames(expression);
  const distributionArray = BuildDistributionArray(parameters, distributionNames);
  const zippedArguments = ZipDistributionArray(arguments_, distributionArray);
  return IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? Distribute2(zippedArguments) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? Distribute2(zippedArguments) : [arguments_];
}

// node_modules/typebox/build/type/engine/call/resolve_target.mjs
function FromNotResolvable() {
  return ["(not-resolvable)", Never()];
}
function FromNotGeneric() {
  return ["(not-generic)", Never()];
}
function FromGeneric(name, parameters, expression) {
  return [name, Generic(parameters, expression)];
}
function FromRef4(context, ref, arguments_) {
  return ref in context ? FromType6(context, ref, context[ref], arguments_) : FromNotResolvable();
}
function FromType6(context, name, target, arguments_) {
  return IsGeneric(target) ? FromGeneric(name, target.parameters, target.expression) : IsRef(target) ? FromRef4(context, target.$ref, arguments_) : FromNotGeneric();
}
function ResolveTarget(context, target, arguments_) {
  return FromType6(context, "(anonymous)", target, arguments_);
}

// node_modules/typebox/build/type/engine/call/resolve_arguments.mjs
function AssertArgumentExtends(name, type, extends_) {
  if (IsInfer(type) || IsCall(type) || result_exports.IsExtendsTrueLike(Extends({}, type, extends_)))
    return;
  const cause = { parameter: name, expect: extends_, actual: type };
  throw new Error(`Argument for parameter ${name} does not satisfy constraint`, { cause });
}
function BindArgument(context, state, name, extends_, type) {
  const instantiatedArgument = InstantiateType(context, state, type);
  AssertArgumentExtends(name, instantiatedArgument, extends_);
  return memory_exports.Assign(context, { [name]: instantiatedArgument });
}
function BindArguments(context, state, parameterLeft, parameterRight, arguments_) {
  const instantiatedExtends = InstantiateType(context, state, parameterLeft.extends);
  const instantiatedEquals = InstantiateType(context, state, parameterLeft.equals);
  return guard_exports.ShiftLeft(arguments_, (left, right) => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, left), state, parameterRight, right), () => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, instantiatedEquals), state, parameterRight, []));
}
function BindParameters(context, state, parameters, arguments_) {
  return guard_exports.ShiftLeft(parameters, (left, right) => BindArguments(context, state, left, right, arguments_), () => context);
}
function ResolveArgumentsContext(context, state, parameters, arguments_) {
  return BindParameters(context, state, parameters, arguments_);
}

// node_modules/typebox/build/type/engine/call/instantiate.mjs
var instantiationDepth = 0;
var instantiationCount = 0;
function InstantiationAssert() {
  if (guard_exports.IsLessThan(instantiationCount, settings_exports.Get().maxInstantiationCount))
    return;
  throw Error("Type instantiation is excessively deep and possibly infinite");
}
function InstantiationIncrement() {
  InstantiationAssert();
  instantiationCount++;
  instantiationDepth++;
}
function InstantiationDecrement() {
  instantiationDepth--;
  if (guard_exports.IsEqual(instantiationDepth, 0))
    instantiationCount = 0;
}
function Peek(state) {
  const result = guard_exports.IsGreaterThan(state.callstack.length, 0) ? state.callstack[state.callstack.length - 1] : "";
  return result;
}
function IsTailCall(state, name) {
  const result = guard_exports.IsEqual(Peek(state), name);
  return result;
}
function CallDispatch(context, state, target, parameters, expression, arguments_) {
  InstantiationIncrement();
  try {
    const argumentsContext = ResolveArgumentsContext(context, state, parameters, arguments_);
    const returnType = InstantiateType(argumentsContext, State([...state["callstack"], target["$ref"]], state["visited"]), expression);
    return InstantiateType(argumentsContext, State([], []), returnType);
  } finally {
    InstantiationDecrement();
  }
}
function CallDistributed(context, state, target, parameters, expression, distributedArguments) {
  return distributedArguments.reduce((result, arguments_) => {
    const returnType = CallDispatch(context, state, target, parameters, expression, arguments_);
    return [...result, returnType];
  }, []);
}
function CallImmediate(context, state, target, parameters, expression, arguments_) {
  const distributedArguments = DistributeArguments(parameters, arguments_, expression);
  const returnTypes = CallDistributed(context, state, target, parameters, expression, distributedArguments);
  const result = guard_exports.IsEqual(returnTypes.length, 1) ? returnTypes[0] : EvaluateUnion(returnTypes);
  return result;
}
function CallInstantiate(context, state, target, arguments_) {
  const instantiatedArguments = InstantiateTypes(context, state, arguments_);
  const resolved = ResolveTarget(context, target, arguments_);
  const name = resolved[0];
  const type = resolved[1];
  const result = IsGeneric(type) ? IsTailCall(state, name) ? CallConstruct(Ref(name), instantiatedArguments) : CallImmediate(context, state, Ref(name), type.parameters, type.expression, instantiatedArguments) : CallConstruct(target, instantiatedArguments);
  return result;
}

// node_modules/typebox/build/type/types/call.mjs
function CallConstruct(target, arguments_) {
  return memory_exports.Create({ ["~kind"]: "Call" }, { type: "call", target, arguments: arguments_ }, {});
}
function Call(target, arguments_) {
  return CallInstantiate({}, State([], []), target, arguments_);
}
function IsCall(value) {
  return IsKind(value, "Call");
}

// node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs
function RemoveImmutableOperation(type) {
  return memory_exports.Discard(type, ["~immutable"]);
}
function RemoveImmutableAction(type, options) {
  const result = memory_exports.Update(RemoveImmutableOperation(type), {}, options);
  return result;
}
function RemoveImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/intrinsics/mapping.mjs
function ApplyMapping(mapping, value) {
  return mapping(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs
function FromLiteral3(mapping, value) {
  return guard_exports.IsString(value) ? Literal(ApplyMapping(mapping, value)) : Literal(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs
function FromTemplateLiteral(mapping, pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType7(mapping, evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/intrinsics/from_union.mjs
function FromUnion2(mapping, types) {
  const result = types.map((type) => FromType7(mapping, type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/intrinsics/from_type.mjs
function FromType7(mapping, type) {
  return IsLiteral(type) ? FromLiteral3(mapping, type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) : IsUnion(type) ? FromUnion2(mapping, type.anyOf) : type;
}

// node_modules/typebox/build/type/action/capitalize.mjs
function CapitalizeDeferred(type, options = {}) {
  return Deferred("Capitalize", [type], options);
}
function Capitalize(type, options = {}) {
  return CapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/lowercase.mjs
function LowercaseDeferred(type, options = {}) {
  return Deferred("Lowercase", [type], options);
}
function Lowercase(type, options = {}) {
  return LowercaseAction(type, options);
}

// node_modules/typebox/build/type/action/uncapitalize.mjs
function UncapitalizeDeferred(type, options = {}) {
  return Deferred("Uncapitalize", [type], options);
}
function Uncapitalize(type, options = {}) {
  return UncapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/uppercase.mjs
function UppercaseDeferred(type, options = {}) {
  return Deferred("Uppercase", [type], options);
}
function Uppercase(type, options = {}) {
  return UppercaseAction(type, options);
}

// node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs
var CapitalizeMapping = (input) => input[0].toUpperCase() + input.slice(1);
var LowercaseMapping = (input) => input.toLowerCase();
var UncapitalizeMapping = (input) => input[0].toLowerCase() + input.slice(1);
var UppercaseMapping = (input) => input.toUpperCase();
function CapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(CapitalizeMapping, type), {}, options) : CapitalizeDeferred(type, options);
  return result;
}
function LowercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(LowercaseMapping, type), {}, options) : LowercaseDeferred(type, options);
  return result;
}
function UncapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UncapitalizeMapping, type), {}, options) : UncapitalizeDeferred(type, options);
  return result;
}
function UppercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UppercaseMapping, type), {}, options) : UppercaseDeferred(type, options);
  return result;
}
function CapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return CapitalizeAction(instantiatedType, options);
}
function LowercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return LowercaseAction(instantiatedType, options);
}
function UncapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UncapitalizeAction(instantiatedType, options);
}
function UppercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UppercaseAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/conditional.mjs
function ConditionalDeferred(left, right, true_, false_, options = {}) {
  return Deferred("Conditional", [left, right, true_, false_], options);
}
function Conditional(left, right, true_, false_, options = {}) {
  return ConditionalAction({}, State([], []), left, right, true_, false_, options);
}

// node_modules/typebox/build/type/engine/conditional/instantiate.mjs
function ConditionalOperation(context, state, left, right, true_, false_) {
  const extendsResult = Extends(context, left, right);
  return result_exports.IsExtendsUnion(extendsResult) ? Union([InstantiateType(extendsResult.inferred, state, true_), InstantiateType(context, state, false_)]) : result_exports.IsExtendsTrue(extendsResult) ? InstantiateType(extendsResult.inferred, state, true_) : InstantiateType(context, state, false_);
}
function ConditionalAction(context, state, left, right, true_, false_, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ConditionalOperation(context, state, left, right, true_, false_), {}, options) : ConditionalDeferred(left, right, true_, false_, options);
  return result;
}
function ConditionalInstantiate(context, state, left, right, true_, false_, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ConditionalAction(context, state, instantiatedLeft, instantiatedRight, true_, false_, options);
}

// node_modules/typebox/build/type/action/constructor_parameters.mjs
function ConstructorParametersDeferred(type, options = {}) {
  return Deferred("ConstructorParameters", [type], options);
}
function ConstructorParameters(type, options = {}) {
  return ConstructorParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs
function ConstructorParametersOperation(type) {
  const parameters = IsConstructor2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ConstructorParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ConstructorParametersOperation(type), {}, options) : ConstructorParametersDeferred(type, options);
  return result;
}
function ConstructorParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ConstructorParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/exclude.mjs
function ExcludeDeferred(left, right, options = {}) {
  return Deferred("Exclude", [left, right], options);
}
function Exclude(left, right, options = {}) {
  return ExcludeAction(left, right, options);
}

// node_modules/typebox/build/type/engine/exclude/instantiate.mjs
function ExcludeAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExcludeOperation(left, right), {}, options) : ExcludeDeferred(left, right, options);
  return result;
}
function ExcludeInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExcludeAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/action/extract.mjs
function ExtractDeferred(left, right, options = {}) {
  return Deferred("Extract", [left, right], options);
}
function Extract(left, right, options = {}) {
  return ExtractAction(left, right, options);
}

// node_modules/typebox/build/type/engine/extract/operation.mjs
function ExtractType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [left] : [];
  return result;
}
function ExtractUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExtractType(head, right)];
  }, []);
}
function ExtractOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExtractUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/extract/instantiate.mjs
function ExtractAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExtractOperation(left, right), {}, options) : ExtractDeferred(left, right, options);
  return result;
}
function ExtractInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExtractAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs
function KeysToLiterals(keys) {
  return keys.reduce((result, left) => {
    return IsLiteralValue(left) ? [...result, Literal(left)] : result;
  }, []);
}
function KeysToIndexer(keys) {
  const literals = KeysToLiterals(keys);
  const result = Union(literals);
  return result;
}

// node_modules/typebox/build/type/action/indexed.mjs
function IndexDeferred(type, indexer, options = {}) {
  return Deferred("Index", [type, indexer], options);
}
function Index(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return IndexAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/object/from_cyclic.mjs
function FromCyclic(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType8(target);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_dependent.mjs
function FromDependent(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType8(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_intersect.mjs
function CollapseIntersectProperties(left, right) {
  const leftKeys = guard_exports.Keys(left).filter((key) => !guard_exports.HasPropertyKey(right, key));
  const rightKeys = guard_exports.Keys(right).filter((key) => !guard_exports.HasPropertyKey(left, key));
  const sharedKeys = guard_exports.Keys(left).filter((key) => guard_exports.HasPropertyKey(right, key));
  const leftProperties = leftKeys.reduce((result, key) => ({ ...result, [key]: left[key] }), {});
  const rightProperties = rightKeys.reduce((result, key) => ({ ...result, [key]: right[key] }), {});
  const sharedProperties = sharedKeys.reduce((result, key) => ({ ...result, [key]: EvaluateIntersect([left[key], right[key]]) }), {});
  const unique = memory_exports.Assign(leftProperties, rightProperties);
  const shared = memory_exports.Assign(unique, sharedProperties);
  return shared;
}
function FromIntersect(types) {
  return types.reduce((result, left) => {
    return CollapseIntersectProperties(result, FromType8(left));
  }, {});
}

// node_modules/typebox/build/type/engine/object/from_object.mjs
function FromObject3(properties) {
  return properties;
}

// node_modules/typebox/build/type/engine/object/from_tuple.mjs
function FromTuple(types) {
  const object = TupleToObject(Tuple(types));
  const result = FromType8(object);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_union.mjs
function CollapseUnionProperties(left, right) {
  const sharedKeys = guard_exports.Keys(left).filter((key) => key in right);
  const result = sharedKeys.reduce((result2, key) => {
    return { ...result2, [key]: EvaluateUnion([left[key], right[key]]) };
  }, {});
  return result;
}
function ReduceVariants(types, result) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, CollapseUnionProperties(result, FromType8(left))), () => result);
}
function FromUnion3(types) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, FromType8(left)), () => Unreachable());
}

// node_modules/typebox/build/type/engine/object/from_type.mjs
function FromType8(type) {
  return IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) : IsDependent(type) ? FromDependent(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect(type.allOf) : IsUnion(type) ? FromUnion3(type.anyOf) : IsTuple(type) ? FromTuple(type.items) : IsObject2(type) ? FromObject3(type.properties) : {};
}

// node_modules/typebox/build/type/engine/object/collapse.mjs
function CollapseToObject(type) {
  const properties = FromType8(type);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/helpers/keys.mjs
var integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");
function ConvertToIntegerKey(value) {
  const normal = `${value}`;
  return integerKeyPattern.test(normal) ? parseInt(normal) : value;
}

// node_modules/typebox/build/type/engine/indexed/from_array.mjs
function NormalizeLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function NormalizeIndexerTypes(types) {
  return types.map((type) => NormalizeIndexer(type));
}
function NormalizeIndexer(type) {
  return IsIntersect(type) ? Intersect(NormalizeIndexerTypes(type.allOf)) : IsUnion(type) ? Union(NormalizeIndexerTypes(type.anyOf)) : IsLiteral(type) ? NormalizeLiteral(type.const) : type;
}
function FromArray2(type, indexer) {
  const normalizedIndexer = NormalizeIndexer(indexer);
  const check = Extends({}, normalizedIndexer, Number2());
  const result = (
    // indexer
    result_exports.IsExtendsTrueLike(check) ? type : IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Number2() : Never()
  );
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs
function FromCyclic2(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType9(target);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_dependent.mjs
function FromDependent2(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_enum.mjs
function FromEnum(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_intersect.mjs
function FromIntersect2(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_literal.mjs
function FromLiteral4(value) {
  const result = [`${value}`];
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs
function FromTemplateLiteral2(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_union.mjs
function FromUnion4(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType9(left)];
  }, []);
}

// node_modules/typebox/build/type/engine/indexable/from_type.mjs
function FromType9(type) {
  return IsCyclic(type) ? FromCyclic2(type.$defs, type.$ref) : IsDependent(type) ? FromDependent2(type.if, type.then, type.else) : IsEnum(type) ? FromEnum(type.enum) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsLiteral(type) ? FromLiteral4(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral2(type.pattern) : IsUnion(type) ? FromUnion4(type.anyOf) : [];
}

// node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs
function ToIndexableKeys(type) {
  const result = FromType9(type);
  return result;
}

// node_modules/typebox/build/type/engine/this/expand_this.mjs
function FromTypes5(properties, types) {
  return types.map((type) => FromType10(properties, type));
}
function FromType10(properties, type) {
  return IsArray2(type) ? _Array_(FromType10(properties, type.items)) : IsConstructor2(type) ? Constructor(FromTypes5(properties, type.parameters), FromType10(properties, type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes5(properties, type.parameters), FromType10(properties, type.returnType)) : IsTuple(type) ? Tuple(FromTypes5(properties, type.items)) : IsUnion(type) ? Union(FromTypes5(properties, type.anyOf)) : IsIntersect(type) ? Intersect(FromTypes5(properties, type.allOf)) : IsThis(type) ? _Object_(properties) : type;
}
function ExpandThis(properties, type) {
  const result = FromType10(properties, type);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/from_object.mjs
function IndexProperty(properties, key) {
  const selectedType = key in properties ? properties[key] : Never();
  const result = ExpandThis(properties, selectedType);
  return result;
}
function IndexProperties(properties, keys) {
  return keys.reduce((result, left) => {
    return [...result, IndexProperty(properties, left)];
  }, []);
}
function FromIndexer(properties, indexer) {
  const keys = ToIndexableKeys(indexer);
  const variants = IndexProperties(properties, keys);
  const result = EvaluateUnion(variants);
  return result;
}
var NumericKeyPattern = new RegExp(IntegerKey);
function NumericKeys(keys) {
  const result = keys.filter((key) => NumericKeyPattern.test(key));
  return result;
}
function FromIndexerNumber(properties) {
  const keys = PropertyKeys(properties);
  const numericKeys = NumericKeys(keys);
  const variants = IndexProperties(properties, numericKeys);
  const result = EvaluateUnion(variants);
  return result;
}
function FromObject4(properties, indexer) {
  const result = IsNumber3(indexer) ? FromIndexerNumber(properties) : FromIndexer(properties, indexer);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/array_indexer.mjs
function ConvertLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function ArrayIndexerTypes(types) {
  return types.map((type) => FormatArrayIndexer(type));
}
function FormatArrayIndexer(type) {
  return IsIntersect(type) ? Intersect(ArrayIndexerTypes(type.allOf)) : IsUnion(type) ? Union(ArrayIndexerTypes(type.anyOf)) : IsLiteral(type) ? ConvertLiteral(type.const) : type;
}

// node_modules/typebox/build/type/engine/indexed/from_tuple.mjs
function IndexElementsWithIndexer(types, indexer) {
  return types.reduceRight((result, right, index) => {
    const check = Extends({}, Literal(index), indexer);
    return result_exports.IsExtendsTrueLike(check) ? [right, ...result] : result;
  }, []);
}
function FromTupleWithIndexer(types, indexer) {
  const formattedArrayIndexer = FormatArrayIndexer(indexer);
  const elements = IndexElementsWithIndexer(types, formattedArrayIndexer);
  return EvaluateUnionFast(elements);
}
function FromTupleWithoutIndexer(types) {
  return EvaluateUnionFast(types);
}
function FromTuple2(types, indexer) {
  return (
    // length (intrinsic)
    IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Literal(types.length) : IsNumber3(indexer) || IsInteger2(indexer) ? FromTupleWithoutIndexer(types) : FromTupleWithIndexer(types, indexer)
  );
}

// node_modules/typebox/build/type/engine/indexed/from_type.mjs
function FromType11(type, indexer) {
  return IsArray2(type) ? FromArray2(type.items, indexer) : IsObject2(type) ? FromObject4(type.properties, indexer) : IsTuple(type) ? FromTuple2(type.items, indexer) : Never();
}

// node_modules/typebox/build/type/engine/indexed/instantiate.mjs
function NormalizeType(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function IndexAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType11(NormalizeType(type), indexer), {}, options) : IndexDeferred(type, indexer, options);
  return result;
}
function IndexInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return IndexAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/instance_type.mjs
function InstanceTypeDeferred(type, options = {}) {
  return Deferred("InstanceType", [type], options);
}
function InstanceType(type, options = {}) {
  return InstanceTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/instance_type/instantiate.mjs
function InstanceTypeOperation(type) {
  return IsConstructor2(type) ? type["instanceType"] : Never();
}
function InstanceTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(InstanceTypeOperation(type), {}, options) : InstanceTypeDeferred(type, options);
  return result;
}
function InstanceTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return InstanceTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/keyof.mjs
function KeyOfDeferred(type, options = {}) {
  return Deferred("KeyOf", [type], options);
}
function KeyOf2(type, options = {}) {
  return KeyOfAction(type, options);
}

// node_modules/typebox/build/type/engine/keyof/from_any.mjs
function FromAny() {
  return Union([Number2(), String2(), Symbol2()]);
}

// node_modules/typebox/build/type/engine/keyof/from_array.mjs
function FromArray3(_type) {
  return Number2();
}

// node_modules/typebox/build/type/engine/keyof/from_object.mjs
function FromPropertyKeys(keys) {
  const result = keys.reduce((result2, left) => {
    return IsLiteralValue(left) ? [...result2, Literal(ConvertToIntegerKey(left))] : Unreachable();
  }, []);
  return result;
}
function FromObject5(properties) {
  const propertyKeys = guard_exports.Keys(properties);
  const variants = FromPropertyKeys(propertyKeys);
  const result = EvaluateUnionFast(variants);
  return result;
}

// node_modules/typebox/build/type/engine/keyof/from_record.mjs
function FromRecord2(type) {
  return RecordKey(type);
}

// node_modules/typebox/build/type/engine/keyof/from_tuple.mjs
function FromTuple3(types) {
  const result = types.map((_, index) => Literal(index));
  return EvaluateUnionFast(result);
}

// node_modules/typebox/build/type/engine/keyof/from_type.mjs
function FromType12(type) {
  return IsAny(type) ? FromAny() : IsArray2(type) ? FromArray3(type.items) : IsObject2(type) ? FromObject5(type.properties) : IsRecord(type) ? FromRecord2(type) : IsTuple(type) ? FromTuple3(type.items) : Never();
}

// node_modules/typebox/build/type/engine/keyof/instantiate.mjs
function NormalizeType2(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function KeyOfAction(type, options) {
  return CanInstantiate([type]) ? memory_exports.Update(FromType12(NormalizeType2(type)), {}, options) : KeyOfDeferred(type, options);
}
function KeyOfInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return KeyOfAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/mapped.mjs
function MappedDeferred(identifier, type, as, property, options = {}) {
  return Deferred("Mapped", [identifier, type, as, property], options);
}
function Mapped(identifier, type, as, property, options = {}) {
  return MappedAction({}, State([], []), identifier, type, as, property, options);
}

// node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs
function FromTemplateLiteral3(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType13(evaluated);
  return result;
}
function FromUnion5(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType13(left)];
  }, []);
}
function FromEnum2(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType13(evaluated);
  return result;
}
function FromLiteral5(value) {
  const result = guard_exports.IsNumber(value) ? [Literal(`${value}`)] : [Literal(value)];
  return result;
}
function FromType13(type) {
  const result = IsEnum(type) ? FromEnum2(type.enum) : IsLiteral(type) ? FromLiteral5(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral3(type.pattern) : IsUnion(type) ? FromUnion5(type.anyOf) : [type];
  return result;
}
function MappedVariants(type) {
  const result = FromType13(type);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs
function CanonicalAs(instantiatedAs) {
  const result = IsTemplateLiteral(instantiatedAs) ? EvaluateTemplateLiteral(instantiatedAs.pattern) : instantiatedAs;
  return result;
}
function MappedVariant(context, state, identifier, variant, as, property) {
  const variantContext = memory_exports.Assign(context, { [identifier["name"]]: variant });
  const instantiatedAs = InstantiateType(variantContext, state, as);
  const canonicalAs = CanonicalAs(instantiatedAs);
  const instantiatedProperty = InstantiateType(variantContext, state, property);
  return IsLiteralNumber(canonicalAs) || IsLiteralString(canonicalAs) ? { [canonicalAs.const]: instantiatedProperty } : {};
}
function MappedProperties(context, state, identifier, variants, as, property) {
  return variants.reduce((result, left) => {
    return [...result, MappedVariant(context, state, identifier, left, as, property)];
  }, []);
}
function MappedObjects(properties) {
  return properties.reduce((result, left) => {
    return [...result, _Object_(left)];
  }, []);
}
function MappedOperation(context, state, identifier, type, as, property) {
  const variants = MappedVariants(type);
  const mappedProperties = MappedProperties(context, state, identifier, variants, as, property);
  const mappedObjects = MappedObjects(mappedProperties);
  const result = EvaluateIntersect(mappedObjects);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/instantiate.mjs
function MappedAction(context, state, identifier, type, as, property, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(MappedOperation(context, state, identifier, type, as, property), {}, options) : MappedDeferred(identifier, type, as, property, options);
  return result;
}
function MappedInstantiate(context, state, identifier, type, as, property, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return MappedAction(context, state, identifier, instantiatedType, as, property, options);
}

// node_modules/typebox/build/type/engine/module/instantiate.mjs
function InstantiateCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateCyclic(declarationContext, key, declarations[key]) };
  }, {});
}
function InstantiateNonCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => !cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateType(declarationContext, State([], []), declarations[key]) };
  }, {});
}
function InstantiateModule(context, declarations, options) {
  const cyclicCandidates = CyclicCandidates(declarations);
  const instantiatedCyclics = InstantiateCyclics(context, declarations, cyclicCandidates);
  const instantiatedNonCyclics = InstantiateNonCyclics(context, declarations, cyclicCandidates);
  const instantiatedModule = { ...instantiatedCyclics, ...instantiatedNonCyclics };
  return memory_exports.Update(instantiatedModule, {}, options);
}
function ModuleInstantiate(context, _state, declarations, options) {
  const instantiatedModule = InstantiateModule(context, declarations, options);
  return instantiatedModule;
}

// node_modules/typebox/build/type/action/non_nullable.mjs
function NonNullableDeferred(type, options = {}) {
  return Deferred("NonNullable", [type], options);
}
function NonNullable(type, options = {}) {
  return NonNullableAction(type, options);
}

// node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs
function NonNullableOperation(type) {
  const excluded = Union([Null(), Undefined()]);
  return ExcludeAction(type, excluded, {});
}
function NonNullableAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(NonNullableOperation(type), {}, options) : NonNullableDeferred(type, options);
  return result;
}
function NonNullableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return NonNullableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/omit.mjs
function OmitDeferred(type, indexer, options = {}) {
  return Deferred("Omit", [type, indexer], options);
}
function Omit(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return OmitAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/indexable/to_indexable.mjs
function ToIndexable(type) {
  const collapsed = CollapseToObject(type);
  const result = IsObject2(collapsed) ? collapsed.properties : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/omit/from_type.mjs
function FromKeys(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? result2 : { ...result2, [key]: properties[key] };
  }, {});
  return result;
}
function FromType14(type, indexer) {
  const indexable = ToIndexable(type);
  const indexableKeys = ToIndexableKeys(indexer);
  const omitted = FromKeys(indexable, indexableKeys);
  const result = _Object_(omitted);
  return result;
}

// node_modules/typebox/build/type/engine/omit/instantiate.mjs
function OmitAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType14(type, indexer), {}, options) : OmitDeferred(type, indexer, options);
  return result;
}
function OmitInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return OmitAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/parameters.mjs
function ParametersDeferred(type, options = {}) {
  return Deferred("Parameters", [type], options);
}
function Parameters(type, options = {}) {
  return ParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/parameters/instantiate.mjs
function ParametersOperation(type) {
  const parameters = IsFunction2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ParametersOperation(type), {}, options) : ParametersDeferred(type, options);
  return result;
}
function ParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/partial.mjs
function PartialDeferred(type, options = {}) {
  return Deferred("Partial", [type], options);
}
function Partial(type, options = {}) {
  return PartialAction(type, options);
}

// node_modules/typebox/build/type/engine/partial/from_cyclic.mjs
function FromCyclic3(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType15(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_dependent.mjs
function FromDependent3(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_intersect.mjs
function FromIntersect3(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_union.mjs
function FromUnion6(types) {
  const result = types.map((type) => FromType15(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/partial/from_object.mjs
function FromObject6(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_type.mjs
function FromType15(type) {
  return IsCyclic(type) ? FromCyclic3(type.$defs, type.$ref) : IsDependent(type) ? FromDependent3(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion6(type.anyOf) : IsObject2(type) ? FromObject6(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/engine/partial/instantiate.mjs
function PartialAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType15(type), {}, options) : PartialDeferred(type, options);
  return result;
}
function PartialInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return PartialAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/pick.mjs
function PickDeferred(type, indexer, options = {}) {
  return Deferred("Pick", [type, indexer], options);
}
function Pick(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return PickAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/pick/from_type.mjs
function FromKeys2(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? memory_exports.Assign(result2, { [key]: properties[key] }) : result2;
  }, {});
  return result;
}
function FromType16(type, indexer) {
  const indexable = ToIndexable(type);
  const keys = ToIndexableKeys(indexer);
  const applied = FromKeys2(indexable, keys);
  const result = _Object_(applied);
  return result;
}

// node_modules/typebox/build/type/engine/pick/instantiate.mjs
function PickAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType16(type, indexer), {}, options) : PickDeferred(type, indexer, options);
  return result;
}
function PickInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return PickAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/readonly_object.mjs
function ReadonlyObjectDeferred(type, options = {}) {
  return Deferred("ReadonlyObject", [type], options);
}
function ReadonlyObject(type, options = {}) {
  return ReadonlyObjectAction(type, options);
}
var ReadonlyType = ReadonlyObject;

// node_modules/typebox/build/type/engine/readonly_object/from_array.mjs
function FromArray4(type) {
  const result = AddImmutable(_Array_(type));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs
function FromCyclic4(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType17(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs
function FromDependent4(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs
function FromIntersect4(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_object.mjs
function FromObject7(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddReadonly(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs
function FromTuple4(types) {
  const result = AddImmutable(Tuple(types));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_union.mjs
function FromUnion7(types) {
  const result = types.map((type) => FromType17(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/readonly_object/from_type.mjs
function FromType17(type) {
  return IsArray2(type) ? FromArray4(type.items) : IsCyclic(type) ? FromCyclic4(type.$defs, type.$ref) : IsDependent(type) ? FromDependent4(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect4(type.allOf) : IsObject2(type) ? FromObject7(type.properties) : IsTuple(type) ? FromTuple4(type.items) : IsUnion(type) ? FromUnion7(type.anyOf) : type;
}

// node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs
function ReadonlyObjectAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType17(type), {}, options) : ReadonlyObjectDeferred(type);
  return result;
}
function ReadonlyObjectInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReadonlyObjectAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/ref/instantiate.mjs
function RefInstantiate(context, state, type, ref) {
  return state.visited.includes(ref) ? type : ref in context ? InstantiateType(context, State(state["callstack"], [...state["visited"], ref]), context[ref]) : type;
}

// node_modules/typebox/build/type/engine/required/from_cyclic.mjs
function FromCyclic5(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType18(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_dependent.mjs
function FromDependent5(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_intersect.mjs
function FromIntersect5(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_union.mjs
function FromUnion8(types) {
  const result = types.map((type) => FromType18(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/required/from_object.mjs
function FromObject8(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: RemoveOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_type.mjs
function FromType18(type) {
  return IsCyclic(type) ? FromCyclic5(type.$defs, type.$ref) : IsDependent(type) ? FromDependent5(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect5(type.allOf) : IsUnion(type) ? FromUnion8(type.anyOf) : IsObject2(type) ? FromObject8(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/action/required.mjs
function RequiredDeferred(type, options = {}) {
  return Deferred("Required", [type], options);
}
function Required(type, options = {}) {
  return RequiredAction(type, options);
}

// node_modules/typebox/build/type/engine/required/instantiate.mjs
function RequiredAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType18(type), {}, options) : RequiredDeferred(type, options);
  return result;
}
function RequiredInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return RequiredAction(instaniatedType, options);
}

// node_modules/typebox/build/type/action/return_type.mjs
function ReturnTypeDeferred(type, options = {}) {
  return Deferred("ReturnType", [type], options);
}
function ReturnType(type, options = {}) {
  return ReturnTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/return_type/instantiate.mjs
function ReturnTypeOperation(type) {
  return IsFunction2(type) ? type["returnType"] : Never();
}
function ReturnTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ReturnTypeOperation(type), {}, options) : ReturnTypeDeferred(type, options);
  return result;
}
function ReturnTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReturnTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/with.mjs
function WithDeferred(type, options) {
  return Deferred("With", [type, options], {});
}
function With2(type, options) {
  return WithAction(type, options);
}

// node_modules/typebox/build/type/engine/with/instantiate.mjs
function WithAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(type, {}, options) : WithDeferred(type, options);
  return result;
}
function WithInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return WithAction(instaniatedType, options);
}

// node_modules/typebox/build/type/engine/rest/spread.mjs
function SpreadElement(type) {
  const result = IsRest(type) ? IsTuple(type.items) ? RestSpread(type.items.items) : IsInfer(type.items) ? [type] : IsRef(type.items) ? [type] : [Never()] : [type];
  return result;
}
function RestSpread(types) {
  const result = types.reduce((result2, left) => {
    return [...result2, ...SpreadElement(left)];
  }, []);
  return result;
}

// node_modules/typebox/build/type/engine/instantiate.mjs
function State(callstack, visited) {
  return { callstack, visited };
}
function CanInstantiate(types) {
  return guard_exports.ShiftLeft(types, (left, right) => IsRef(left) ? false : CanInstantiate(right), () => true);
}
function InstantiateProperties(context, state, properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: InstantiateType(context, state, properties[key]) };
  }, {});
}
function InstantiateElements(context, state, types) {
  const elements = InstantiateTypes(context, state, types);
  const result = RestSpread(elements);
  return result;
}
function InstantiateTypes(context, state, types) {
  return types.map((type) => InstantiateType(context, state, type));
}
function WithModifiers(type, instantiatedType) {
  const withOptional = IsOptional(type) ? AddOptionalAction(instantiatedType, {}) : instantiatedType;
  const withReadonly = IsReadonly(type) ? AddReadonlyAction(withOptional, {}) : withOptional;
  const withImmutable = IsImmutable(type) ? AddImmutableAction(withReadonly, {}) : withReadonly;
  return withImmutable;
}
function InstantiateDeferred(context, state, action, parameters, options) {
  return (
    // Modifiers
    guard_exports.IsEqual(action, "AddImmutable") ? AddImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveImmutable") ? RemoveImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddReadonly") ? AddReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveReadonly") ? RemoveReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddOptional") ? AddOptionalInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveOptional") ? RemoveOptionalInstantiate(context, state, parameters[0], options) : (
      // Actions
      guard_exports.IsEqual(action, "Capitalize") ? CapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Conditional") ? ConditionalInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "ConstructorParameters") ? ConstructorParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Evaluate") ? EvaluateInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Exclude") ? ExcludeInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Extract") ? ExtractInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Index") ? IndexInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "InstanceType") ? InstanceTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Interface") ? InterfaceInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "KeyOf") ? KeyOfInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Lowercase") ? LowercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Mapped") ? MappedInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "Module") ? ModuleInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "NonNullable") ? NonNullableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Pick") ? PickInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Parameters") ? ParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Partial") ? PartialInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Omit") ? OmitInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "ReadonlyObject") ? ReadonlyObjectInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Record") ? RecordInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Required") ? RequiredInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "ReturnType") ? ReturnTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "TemplateLiteral") ? TemplateLiteralInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uncapitalize") ? UncapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uppercase") ? UppercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "With") ? WithInstantiate(context, state, parameters[0], parameters[1]) : Deferred(action, parameters, options)
    )
  );
}
function InstantiateImmediate(context, state, type) {
  const instantiatedType = IsRef(type) ? RefInstantiate(context, state, type, type.$ref) : IsArray2(type) ? _Array_(InstantiateType(context, state, type.items), ArrayOptions(type)) : IsCall(type) ? CallInstantiate(context, state, type.target, type.arguments) : IsConstructor2(type) ? Constructor(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.instanceType), ConstructorOptions(type)) : IsFunction2(type) ? _Function_(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.returnType), FunctionOptions(type)) : IsDependent(type) ? Dependent(InstantiateType(context, state, type.if), InstantiateType(context, state, type.then), InstantiateType(context, state, type.else), DependentOptions(type)) : IsIntersect(type) ? Intersect(InstantiateTypes(context, state, type.allOf), IntersectOptions(type)) : IsObject2(type) ? _Object_(InstantiateProperties(context, state, type.properties), ObjectOptions(type)) : IsRecord(type) ? RecordFromPattern(RecordPattern(type), InstantiateType(context, state, RecordValue(type))) : IsRest(type) ? Rest(InstantiateType(context, state, type.items)) : IsTuple(type) ? Tuple(InstantiateElements(context, state, type.items), TupleOptions(type)) : IsUnion(type) ? Union(InstantiateTypes(context, state, type.anyOf), UnionOptions(type)) : type;
  const withModifiers = WithModifiers(type, instantiatedType);
  return withModifiers;
}
function InstantiateType(context, state, type) {
  const result = IsDeferred(type) ? InstantiateDeferred(context, state, type.action, type.parameters, type.options) : InstantiateImmediate(context, state, type);
  return result;
}
function Instantiate(context, type) {
  return InstantiateType(context, State([], []), type);
}

// node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs
function AddImmutableOperation(type) {
  return memory_exports.Update(type, { "~immutable": true }, {});
}
function AddImmutableAction(type, options) {
  const result = memory_exports.Update(AddImmutableOperation(type), {}, options);
  return result;
}
function AddImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_add_immutable.mjs
function AddImmutableDeferred(type, options = {}) {
  return Deferred("AddImmutable", [type], options);
}
function AddImmutable(type, options = {}) {
  return AddImmutableAction(type, options);
}

// node_modules/typebox/build/type/action/evaluate.mjs
function EvaluateDeferred(type, options = {}) {
  return Deferred("Evaluate", [type], options);
}
function Evaluate(type, options = {}) {
  return EvaluateAction(type, options);
}

// node_modules/typebox/build/type/action/module.mjs
function ModuleDeferred(declarations, options = {}) {
  return Deferred("Module", [declarations], options);
}
function Module2(declarations, options = {}) {
  return ModuleInstantiate({}, State([], []), declarations, options);
}

// node_modules/typebox/build/type/script/script.mjs
function Script2(...args) {
  const [context, input, options] = arguments_exports.Match(args, {
    2: (script, options2) => guard_exports.IsString(script) ? [{}, script, options2] : [script, options2, {}],
    3: (context2, script, options2) => [context2, script, options2],
    1: (script) => [{}, script, {}]
  });
  const result = Script(input);
  const parsed = guard_exports.IsArray(result) && guard_exports.IsEqual(result.length, 2) ? InstantiateType(context, State([], []), result[0]) : Never();
  return memory_exports.Update(parsed, {}, options);
}

// node_modules/typebox/build/typebox.mjs
var typebox_exports = {};
__export(typebox_exports, {
  Any: () => Any,
  Array: () => _Array_,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Call: () => Call,
  Capitalize: () => Capitalize,
  Codec: () => Codec,
  Conditional: () => Conditional,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Cyclic: () => Cyclic,
  Decode: () => Decode,
  DecodeBuilder: () => DecodeBuilder,
  Dependent: () => Dependent,
  Encode: () => Encode,
  EncodeBuilder: () => EncodeBuilder,
  Enum: () => Enum,
  Evaluate: () => Evaluate,
  Exclude: () => Exclude,
  Extends: () => Extends,
  ExtendsResult: () => result_exports,
  Extract: () => Extract,
  Function: () => _Function_,
  Generic: () => Generic,
  Identifier: () => Identifier,
  Immutable: () => Immutable,
  Index: () => Index,
  Infer: () => Infer,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Interface: () => Interface,
  Intersect: () => Intersect,
  IsAny: () => IsAny,
  IsArray: () => IsArray2,
  IsBigInt: () => IsBigInt2,
  IsBoolean: () => IsBoolean3,
  IsCall: () => IsCall,
  IsCodec: () => IsCodec,
  IsConstructor: () => IsConstructor2,
  IsCyclic: () => IsCyclic,
  IsDependent: () => IsDependent,
  IsEnum: () => IsEnum,
  IsEnumValue: () => IsEnumValue,
  IsFunction: () => IsFunction2,
  IsGeneric: () => IsGeneric,
  IsIdentifier: () => IsIdentifier,
  IsImmutable: () => IsImmutable,
  IsInfer: () => IsInfer,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect,
  IsKind: () => IsKind,
  IsLiteral: () => IsLiteral,
  IsNever: () => IsNever,
  IsNull: () => IsNull2,
  IsNumber: () => IsNumber3,
  IsObject: () => IsObject2,
  IsOptional: () => IsOptional,
  IsParameter: () => IsParameter,
  IsReadonly: () => IsReadonly,
  IsRecord: () => IsRecord,
  IsRef: () => IsRef,
  IsRefine: () => IsRefine,
  IsRest: () => IsRest,
  IsSchema: () => IsSchema,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol2,
  IsTemplateLiteral: () => IsTemplateLiteral,
  IsThis: () => IsThis,
  IsTuple: () => IsTuple,
  IsUndefined: () => IsUndefined2,
  IsUnion: () => IsUnion,
  IsUnknown: () => IsUnknown,
  IsUnsafe: () => IsUnsafe,
  IsVoid: () => IsVoid,
  KeyOf: () => KeyOf2,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module2,
  Never: () => Never,
  NonNullable: () => NonNullable,
  Null: () => Null,
  Number: () => Number2,
  Object: () => _Object_,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameter: () => Parameter,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Readonly: () => Readonly,
  ReadonlyObject: () => ReadonlyObject,
  ReadonlyType: () => ReadonlyType,
  Record: () => Record,
  RecordKey: () => RecordKey,
  RecordPattern: () => RecordPattern,
  RecordValue: () => RecordValue,
  Ref: () => Ref,
  Refine: () => Refine,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  Script: () => Script2,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral2,
  This: () => This,
  Tuple: () => Tuple,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void,
  With: () => With2
});

// src/config.ts
var configSchema = typebox_exports.Object({
  apiKey: typebox_exports.Optional(
    typebox_exports.String({
      description: "OpenSandbox API key. Prefer the OPEN_SANDBOX_API_KEY environment variable or an OpenClaw SecretRef over hardcoding."
    })
  ),
  domain: typebox_exports.Optional(
    typebox_exports.String({
      description: "OpenSandbox lifecycle server domain (host[:port]) without scheme, e.g. api.opensandbox.io.",
      default: "localhost:8080"
    })
  ),
  protocol: typebox_exports.Optional(
    typebox_exports.Union([typebox_exports.Literal("http"), typebox_exports.Literal("https")], {
      description: "Protocol used to reach the lifecycle server.",
      default: "http"
    })
  ),
  requestTimeoutSeconds: typebox_exports.Optional(
    typebox_exports.Number({
      description: "Timeout in seconds applied to SDK HTTP requests.",
      default: 30
    })
  ),
  useServerProxy: typebox_exports.Optional(
    typebox_exports.Boolean({
      description: "Route execd/file/endpoint traffic through the lifecycle server proxy. Keep enabled when the OpenClaw gateway cannot reach sandbox public endpoints directly (default deployment topology); disable only when sandbox endpoints are reachable from the plugin process.",
      default: true
    })
  ),
  defaultImage: typebox_exports.Optional(
    typebox_exports.String({
      description: "Container image used by sandbox_create when no image is provided.",
      default: "ubuntu"
    })
  ),
  maxOutputBytes: typebox_exports.Optional(
    typebox_exports.Number({
      description: "Maximum bytes of command output or file content returned to the agent; longer output is truncated.",
      default: 65536
    })
  ),
  sandboxCacheSize: typebox_exports.Optional(
    typebox_exports.Number({
      description: "Upper bound of the in-process Sandbox instance LRU cache.",
      default: 8
    })
  )
}, {
  additionalProperties: false
});
function normalizeConfig(config) {
  return {
    apiKey: config.apiKey || void 0,
    domain: config.domain ?? "localhost:8080",
    protocol: config.protocol ?? "http",
    requestTimeoutSeconds: config.requestTimeoutSeconds ?? 30,
    useServerProxy: config.useServerProxy ?? true,
    defaultImage: config.defaultImage ?? "ubuntu",
    maxOutputBytes: config.maxOutputBytes ?? 64 * 1024,
    sandboxCacheSize: config.sandboxCacheSize ?? 8
  };
}

// node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    headers: baseHeaders,
    requestInitExt = void 0,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
  baseUrl = removeTrailingSlash(baseUrl);
  const middlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch: fetch2 = baseFetch,
      Request: Request2 = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      body,
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const serializedBody = body === void 0 ? void 0 : bodySerializer(
      body,
      // Note: we declare mergeHeaders() both here and below because it’s a bit of a chicken-or-egg situation:
      // bodySerializer() needs all headers so we aren’t dropping ones set by the user, however,
      // the result of this ALSO sets the lowest-priority content-type header. So we re-merge below,
      // setting the content-type at the very beginning to be overwritten.
      // Lastly, based on the way headers work, it’s not a simple “present-or-not” check becauase null intentionally un-sets headers.
      mergeHeaders(baseHeaders, headers, params.header)
    );
    const finalHeaders = mergeHeaders(
      // with no body, we should not to set Content-Type
      serializedBody === void 0 || // if serialized body is FormData; browser will correctly set Content-Type & boundary expression
      serializedBody instanceof FormData ? {} : {
        "Content-Type": "application/json"
      },
      baseHeaders,
      headers,
      params.header
    );
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request2(
      createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer }),
      requestInit
    );
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (middlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch: fetch2,
        parseAs,
        querySerializer,
        bodySerializer
      });
      for (const m of middlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request2) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch2(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (middlewares.length) {
          for (let i = middlewares.length - 1; i >= 0; i--) {
            const m = middlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = void 0;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (middlewares.length) {
        for (let i = middlewares.length - 1; i >= 0; i--) {
          const m = middlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    if (response.status === 204 || request.method === "HEAD" || response.headers.get("Content-Length") === "0") {
      return response.ok ? { data: void 0, response } : { error: void 0, response };
    }
    if (response.ok) {
      if (parseAs === "stream") {
        return { data: response.body, response };
      }
      return { data: await response[parseAs](), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {
    }
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    /** Call a GET endpoint */
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    /** Call a PUT endpoint */
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    /** Call a POST endpoint */
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    /** Call a DELETE endpoint */
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    /** Call a OPTIONS endpoint */
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    /** Call a HEAD endpoint */
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    /** Call a PATCH endpoint */
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    /** Call a TRACE endpoint */
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    /** Register middleware */
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        middlewares.push(m);
      }
    },
    /** Unregister middleware */
    eject(...middleware) {
      for (const m of middleware) {
        const i = middlewares.indexOf(m);
        if (i !== -1) {
          middlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these."
    );
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      // case "spaceDelimited":
      // case "pipeDelimited":
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(
            serializeArrayParam(name, value, {
              style: "form",
              explode: true,
              ...options?.array,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        if (typeof value === "object") {
          search.push(
            serializeObjectParam(name, value, {
              style: "deepObject",
              explode: true,
              ...options?.object,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = defaultPathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers();
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== void 0) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// node_modules/@alibaba-group/opensandbox/dist/chunk-67D4V6XL.js
var SandboxError = class {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
  static INTERNAL_UNKNOWN_ERROR = "INTERNAL_UNKNOWN_ERROR";
  static READY_TIMEOUT = "READY_TIMEOUT";
  static UNHEALTHY = "UNHEALTHY";
  static INVALID_ARGUMENT = "INVALID_ARGUMENT";
  static UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE";
};
var SandboxException = class extends Error {
  name = "SandboxException";
  error;
  cause;
  requestId;
  constructor(opts = {}) {
    super(opts.message);
    this.cause = opts.cause;
    this.error = opts.error ?? new SandboxError(SandboxError.INTERNAL_UNKNOWN_ERROR);
    this.requestId = opts.requestId;
  }
};
var SandboxApiException = class extends SandboxException {
  name = "SandboxApiException";
  statusCode;
  rawBody;
  constructor(opts) {
    super({
      message: opts.message,
      cause: opts.cause,
      error: opts.error ?? new SandboxError(SandboxError.UNEXPECTED_RESPONSE, opts.message),
      requestId: opts.requestId
    });
    this.statusCode = opts.statusCode;
    this.rawBody = opts.rawBody;
  }
};
var SandboxReadyTimeoutException = class extends SandboxException {
  name = "SandboxReadyTimeoutException";
  constructor(opts) {
    super({
      message: opts.message,
      cause: opts.cause,
      error: new SandboxError(SandboxError.READY_TIMEOUT, opts.message)
    });
  }
};
function createExecdClient(opts) {
  const createClientFn = createClient.default ?? createClient;
  return createClientFn({
    baseUrl: opts.baseUrl,
    headers: opts.headers,
    fetch: opts.fetch
  });
}
function createEgressClient(opts) {
  const createClientFn = createClient.default ?? createClient;
  return createClientFn({
    baseUrl: opts.baseUrl,
    headers: opts.headers,
    fetch: opts.fetch
  });
}
function readEnvApiKey() {
  const env = globalThis?.process?.env;
  const v = env?.OPEN_SANDBOX_API_KEY;
  return typeof v === "string" && v.length ? v : void 0;
}
function createLifecycleClient(opts = {}) {
  const apiKey = opts.apiKey ?? readEnvApiKey();
  const headers = {
    ...opts.headers ?? {}
  };
  if (apiKey && !headers["OPEN-SANDBOX-API-KEY"]) {
    headers["OPEN-SANDBOX-API-KEY"] = apiKey;
  }
  const createClientFn = createClient.default ?? createClient;
  return createClientFn({
    baseUrl: opts.baseUrl ?? "http://localhost:8080/v1",
    headers,
    fetch: opts.fetch
  });
}
function extractText(results) {
  if (!results || typeof results !== "object") return void 0;
  const r = results;
  const v = r["text/plain"] ?? r.text ?? r.textPlain;
  return v == null ? void 0 : String(v);
}
var ExecutionEventDispatcher = class {
  constructor(execution, handlers) {
    this.execution = execution;
    this.handlers = handlers;
  }
  async dispatch(ev) {
    await this.handlers?.onEvent?.(ev);
    const ts = ev.timestamp ?? Date.now();
    switch (ev.type) {
      case "init": {
        const id = ev.text ?? "";
        if (id) this.execution.id = id;
        const init = { id, timestamp: ts };
        await this.handlers?.onInit?.(init);
        return;
      }
      case "stdout": {
        const msg = { text: ev.text ?? "", timestamp: ts, isError: false };
        if (!this.handlers?.skipAccumulation) {
          this.execution.logs.stdout.push(msg);
        }
        await this.handlers?.onStdout?.(msg);
        return;
      }
      case "stderr": {
        const msg = { text: ev.text ?? "", timestamp: ts, isError: true };
        if (!this.handlers?.skipAccumulation) {
          this.execution.logs.stderr.push(msg);
        }
        await this.handlers?.onStderr?.(msg);
        return;
      }
      case "result": {
        const r = { text: extractText(ev.results), timestamp: ts, raw: ev.results };
        this.execution.result.push(r);
        await this.handlers?.onResult?.(r);
        return;
      }
      case "execution_count": {
        const c = ev.execution_count;
        if (typeof c === "number") this.execution.executionCount = c;
        return;
      }
      case "execution_complete": {
        const ms = ev.execution_time;
        const complete = { timestamp: ts, executionTimeMs: typeof ms === "number" ? ms : 0 };
        this.execution.complete = complete;
        await this.handlers?.onExecutionComplete?.(complete);
        return;
      }
      case "error": {
        const e = ev.error;
        if (e) {
          const err = {
            name: String(e.ename ?? e.name ?? ""),
            value: String(e.evalue ?? e.value ?? ""),
            timestamp: ts,
            traceback: Array.isArray(e.traceback) ? e.traceback.map(String) : []
          };
          this.execution.error = err;
          await this.handlers?.onError?.(err);
        }
        return;
      }
      default:
        return;
    }
  }
};
function throwOnOpenApiFetchError(result, fallbackMessage) {
  if (!result.error) return;
  const requestId = result.response.headers.get("x-request-id") ?? void 0;
  const status = result.response.status ?? 0;
  const err = result.error;
  const message = err?.message ?? err?.error?.message ?? fallbackMessage;
  const code = err?.code ?? err?.error?.code;
  const msg = err?.message ?? err?.error?.message ?? message;
  throw new SandboxApiException({
    message: msg,
    statusCode: status,
    requestId,
    error: code ? new SandboxError(String(code), String(msg ?? "")) : new SandboxError(SandboxError.UNEXPECTED_RESPONSE, String(msg ?? "")),
    rawBody: result.error
  });
}
function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return void 0;
  }
}
async function* parseJsonEventStream(res, opts) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const parsed = tryParseJson(text);
    const err = parsed && typeof parsed === "object" ? parsed : void 0;
    const requestId = res.headers.get("x-request-id") ?? void 0;
    const message = err?.message ?? opts?.fallbackErrorMessage ?? `Stream request failed (status=${res.status})`;
    const code = err?.code ? String(err.code) : SandboxError.UNEXPECTED_RESPONSE;
    throw new SandboxApiException({
      message,
      statusCode: res.status,
      requestId,
      error: new SandboxError(code, err?.message ? String(err.message) : message),
      rawBody: parsed ?? text
    });
  }
  if (!res.body) {
    return;
  }
  const reader = res.body.getReader();
  const decoder2 = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder2.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const rawLine = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) continue;
      const jsonLine = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
      if (!jsonLine) continue;
      const parsed = tryParseJson(jsonLine);
      if (!parsed) continue;
      yield parsed;
    }
  }
  buf += decoder2.decode();
  const last = buf.trim();
  if (last) {
    const jsonLine = last.startsWith("data:") ? last.slice("data:".length).trim() : last;
    const parsed = tryParseJson(jsonLine);
    if (parsed) yield parsed;
  }
}
function joinUrl(baseUrl, pathname) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}
function toRunCommandRequest(command, opts) {
  if (opts?.gid != null && opts.uid == null) {
    throw new Error("uid is required when gid is provided");
  }
  const body = {
    command,
    cwd: opts?.workingDirectory,
    background: !!opts?.background
  };
  if (opts?.timeoutSeconds != null) {
    body.timeout = Math.round(opts.timeoutSeconds * 1e3);
  }
  if (opts?.uid != null) {
    body.uid = opts.uid;
  }
  if (opts?.gid != null) {
    body.gid = opts.gid;
  }
  if (opts?.envs != null) {
    body.envs = opts.envs;
  }
  return body;
}
function toRunInSessionRequest(command, opts) {
  const body = {
    command
  };
  if (opts?.workingDirectory != null) {
    body.cwd = opts.workingDirectory;
  }
  if (opts?.timeoutSeconds != null) {
    body.timeout = Math.round(opts.timeoutSeconds * 1e3);
  }
  return body;
}
function inferForegroundExitCode(execution) {
  const errorValue = execution.error?.value?.trim();
  const parsedExitCode = errorValue && /^-?\d+$/.test(errorValue) ? Number(errorValue) : Number.NaN;
  return execution.error != null ? Number.isFinite(parsedExitCode) ? parsedExitCode : null : execution.complete ? 0 : null;
}
function assertNonBlank(value, field) {
  if (!value.trim()) {
    throw new Error(`${field} cannot be empty`);
  }
}
function parseOptionalDate(value, field) {
  if (value == null) return void 0;
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected ISO string, got ${typeof value}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}
var CommandsAdapter = class {
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
  }
  fetch;
  buildRunStreamSpec(command, opts) {
    assertNonBlank(command, "command");
    return {
      pathname: "/command",
      body: toRunCommandRequest(command, opts),
      fallbackErrorMessage: "Run command failed"
    };
  }
  buildRunInSessionStreamSpec(sessionId, command, opts) {
    assertNonBlank(sessionId, "sessionId");
    assertNonBlank(command, "command");
    return {
      pathname: `/session/${encodeURIComponent(sessionId)}/run`,
      body: toRunInSessionRequest(command, opts),
      fallbackErrorMessage: "Run in session failed"
    };
  }
  async *streamExecution(spec, signal) {
    const url = joinUrl(this.opts.baseUrl, spec.pathname);
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...this.opts.headers ?? {}
      },
      body: JSON.stringify(spec.body),
      signal
    });
    for await (const ev of parseJsonEventStream(res, {
      fallbackErrorMessage: spec.fallbackErrorMessage
    })) {
      yield ev;
    }
  }
  async consumeExecutionStream(stream, handlers, inferExitCode2 = false) {
    const execution = {
      logs: { stdout: [], stderr: [] },
      result: []
    };
    const dispatcher = new ExecutionEventDispatcher(execution, handlers);
    for await (const ev of stream) {
      if (ev.type === "init" && (ev.text ?? "") === "" && execution.id) {
        ev.text = execution.id;
      }
      await dispatcher.dispatch(ev);
    }
    if (inferExitCode2) {
      execution.exitCode = inferForegroundExitCode(execution);
    }
    return execution;
  }
  async interrupt(sessionId) {
    const { error, response } = await this.client.DELETE("/command", {
      params: { query: { id: sessionId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Interrupt command failed");
  }
  async getCommandStatus(commandId) {
    const { data, error, response } = await this.client.GET("/command/status/{id}", {
      params: { path: { id: commandId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get command status failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Get command status failed: unexpected response shape");
    }
    return {
      id: ok.id,
      content: ok.content,
      running: ok.running,
      exitCode: ok.exit_code ?? null,
      error: ok.error,
      startedAt: parseOptionalDate(ok.started_at, "startedAt"),
      finishedAt: parseOptionalDate(ok.finished_at, "finishedAt") ?? null
    };
  }
  async getBackgroundCommandLogs(commandId, cursor) {
    const { data, error, response } = await this.client.GET("/command/{id}/logs", {
      params: { path: { id: commandId }, query: cursor == null ? {} : { cursor } },
      parseAs: "text"
    });
    throwOnOpenApiFetchError({ error, response }, "Get command logs failed");
    let content;
    if (typeof data === "string") {
      content = data;
    } else if (data == null && response.ok) {
      content = "";
    } else {
      throw new Error("Get command logs failed: unexpected response shape");
    }
    const cursorHeader = response.headers.get("EXECD-COMMANDS-TAIL-CURSOR");
    const parsedCursor = cursorHeader != null && cursorHeader !== "" ? Number(cursorHeader) : void 0;
    return {
      content,
      cursor: Number.isFinite(parsedCursor ?? NaN) ? parsedCursor : void 0
    };
  }
  async *runStream(command, opts, signal) {
    for await (const ev of this.streamExecution(
      this.buildRunStreamSpec(command, opts),
      signal
    )) {
      yield ev;
    }
  }
  async run(command, opts, handlers, signal) {
    return this.consumeExecutionStream(
      this.runStream(command, opts, signal),
      handlers,
      !opts?.background
    );
  }
  async createSession(options) {
    const body = options?.workingDirectory != null ? { cwd: options.workingDirectory } : {};
    const { data, error, response } = await this.client.POST("/session", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Create session failed");
    const ok = data;
    if (!ok || typeof ok.session_id !== "string") {
      throw new Error("Create session failed: unexpected response shape");
    }
    return ok.session_id;
  }
  async *runInSessionStream(sessionId, command, opts, signal) {
    for await (const ev of this.streamExecution(
      this.buildRunInSessionStreamSpec(sessionId, command, opts),
      signal
    )) {
      yield ev;
    }
  }
  async runInSession(sessionId, command, options, handlers, signal) {
    return this.consumeExecutionStream(
      this.runInSessionStream(sessionId, command, options, signal),
      handlers,
      true
    );
  }
  async deleteSession(sessionId) {
    const { error, response } = await this.client.DELETE(
      "/session/{sessionId}",
      { params: { path: { sessionId } } }
    );
    throwOnOpenApiFetchError({ error, response }, "Delete session failed");
  }
};
function stripTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === s.length ? s : s.slice(0, end);
}
function expectObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected object`);
  }
  return value;
}
function expectString(value, context) {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected string`);
  }
  return value;
}
function expectNumber(value, context) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context}: expected integer`);
  }
  return value;
}
function expectArray(value, context, mapItem) {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected array`);
  }
  return value.map((item, index) => mapItem(item, `${context}[${index}]`));
}
function optionalStringArray(value, context) {
  if (value == null) return void 0;
  return expectArray(value, context, expectString);
}
function optionalNumberArray(value, context) {
  if (value == null) return void 0;
  return expectArray(value, context, expectNumber);
}
function sanitizeCredentialMatch(value, context) {
  if (value == null) return void 0;
  const raw = expectObject(value, context);
  const match = {
    hosts: expectArray(raw.hosts, `${context}.hosts`, expectString)
  };
  const schemes = optionalStringArray(raw.schemes, `${context}.schemes`);
  if (schemes) {
    match.schemes = schemes.map((scheme, index) => {
      if (scheme !== "https" && scheme !== "http") {
        throw new Error(`${context}.schemes[${index}]: expected "https" or "http"`);
      }
      return scheme;
    });
  }
  const ports = optionalNumberArray(raw.ports, `${context}.ports`);
  if (ports) match.ports = ports;
  const methods = optionalStringArray(raw.methods, `${context}.methods`);
  if (methods) match.methods = methods;
  const paths = optionalStringArray(raw.paths, `${context}.paths`);
  if (paths) match.paths = paths;
  return match;
}
function sanitizeCredentialAuthMetadata(value, context) {
  if (value == null) return void 0;
  const raw = expectObject(value, context);
  const auth = {
    type: expectString(raw.type, `${context}.type`)
  };
  if (raw.name != null) {
    auth.name = expectString(raw.name, `${context}.name`);
  }
  return auth;
}
function sanitizeCredentialMetadata(value, context) {
  const raw = expectObject(value, context);
  return {
    name: expectString(raw.name, `${context}.name`),
    sourceType: expectString(raw.sourceType, `${context}.sourceType`),
    revision: expectNumber(raw.revision, `${context}.revision`)
  };
}
function sanitizeCredentialBindingMetadata(value, context) {
  const raw = expectObject(value, context);
  const binding = {
    name: expectString(raw.name, `${context}.name`),
    revision: expectNumber(raw.revision, `${context}.revision`)
  };
  const match = sanitizeCredentialMatch(raw.match, `${context}.match`);
  if (match) binding.match = match;
  const auth = sanitizeCredentialAuthMetadata(raw.auth, `${context}.auth`);
  if (auth) binding.auth = auth;
  return binding;
}
function sanitizeCredentialVaultState(value, operation) {
  const raw = expectObject(value, `${operation} response`);
  return {
    revision: expectNumber(raw.revision, `${operation} response.revision`),
    credentials: expectArray(
      raw.credentials,
      `${operation} response.credentials`,
      sanitizeCredentialMetadata
    ),
    bindings: expectArray(
      raw.bindings,
      `${operation} response.bindings`,
      sanitizeCredentialBindingMetadata
    )
  };
}
function sanitizeCredentialListResponse(value, operation) {
  const raw = expectObject(value, `${operation} response`);
  const response = {
    revision: expectNumber(raw.revision, `${operation} response.revision`),
    credentials: expectArray(
      raw.credentials,
      `${operation} response.credentials`,
      sanitizeCredentialMetadata
    )
  };
  return response.credentials;
}
function sanitizeCredentialBindingListResponse(value, operation) {
  const raw = expectObject(value, `${operation} response`);
  const response = {
    revision: expectNumber(raw.revision, `${operation} response.revision`),
    bindings: expectArray(
      raw.bindings,
      `${operation} response.bindings`,
      sanitizeCredentialBindingMetadata
    )
  };
  return response.bindings;
}
var EgressAdapter = class {
  constructor(client, rawHttp) {
    this.client = client;
    this.rawBaseUrl = rawHttp ? stripTrailingSlashes(rawHttp.baseUrl) : void 0;
    this.rawHeaders = rawHttp?.headers ?? {};
    this.rawFetch = rawHttp?.fetch ?? fetch;
  }
  rawBaseUrl;
  rawHeaders;
  rawFetch;
  credentialVaultUrl(path) {
    if (!this.rawBaseUrl) {
      throw new Error("Credential Vault transport is not configured");
    }
    return `${this.rawBaseUrl}${path}`;
  }
  async readErrorResponse(response) {
    const text = await response.text();
    if (!text) {
      const message = `HTTP ${response.status}`;
      return { code: SandboxError.UNEXPECTED_RESPONSE, message, rawBody: void 0 };
    }
    try {
      const rawBody = JSON.parse(text);
      if (rawBody && typeof rawBody === "object") {
        const obj = rawBody;
        const code = typeof obj.code === "string" ? obj.code : SandboxError.UNEXPECTED_RESPONSE;
        const message = typeof obj.message === "string" ? obj.message : text;
        return { code, message, rawBody };
      }
      return { code: SandboxError.UNEXPECTED_RESPONSE, message: text, rawBody };
    } catch {
      return { code: SandboxError.UNEXPECTED_RESPONSE, message: text, rawBody: text };
    }
  }
  async requestJson(method, path, operation, jsonBody) {
    const headers = new Headers(this.rawHeaders);
    headers.set("accept", "application/json");
    const init = { method, headers };
    if (jsonBody !== void 0) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(jsonBody);
    }
    let response;
    try {
      response = await this.rawFetch(this.credentialVaultUrl(path), init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SandboxApiException({
        message: `${operation} failed: ${message}`,
        cause: err,
        error: new SandboxError(SandboxError.UNEXPECTED_RESPONSE, message)
      });
    }
    if (!response.ok) {
      const { code, message, rawBody } = await this.readErrorResponse(response);
      throw new SandboxApiException({
        message,
        statusCode: response.status,
        requestId: response.headers.get("x-request-id") ?? void 0,
        error: new SandboxError(code, message),
        rawBody
      });
    }
    if (response.status === 204) {
      return void 0;
    }
    const text = await response.text();
    if (!text) {
      return void 0;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new SandboxApiException({
        message: `${operation} failed: invalid JSON response`,
        cause: err,
        statusCode: response.status,
        requestId: response.headers.get("x-request-id") ?? void 0,
        error: new SandboxError(SandboxError.UNEXPECTED_RESPONSE, "Invalid JSON response"),
        rawBody: text
      });
    }
  }
  async create(request) {
    const payload = await this.requestJson(
      "POST",
      "/credential-vault",
      "Create credential vault",
      request
    );
    return sanitizeCredentialVaultState(payload, "Create credential vault");
  }
  async get() {
    const payload = await this.requestJson(
      "GET",
      "/credential-vault",
      "Get credential vault"
    );
    return sanitizeCredentialVaultState(payload, "Get credential vault");
  }
  async patch(request) {
    const payload = await this.requestJson(
      "PATCH",
      "/credential-vault",
      "Patch credential vault",
      request
    );
    return sanitizeCredentialVaultState(payload, "Patch credential vault");
  }
  async delete() {
    await this.requestJson("DELETE", "/credential-vault", "Delete credential vault");
  }
  async listCredentials() {
    const payload = await this.requestJson(
      "GET",
      "/credential-vault/credentials",
      "List credential vault credentials"
    );
    return sanitizeCredentialListResponse(payload, "List credential vault credentials");
  }
  async getCredential(name) {
    const payload = await this.requestJson(
      "GET",
      `/credential-vault/credentials/${encodeURIComponent(name)}`,
      "Get credential vault credential"
    );
    return sanitizeCredentialMetadata(payload, "Get credential vault credential response");
  }
  async listBindings() {
    const payload = await this.requestJson(
      "GET",
      "/credential-vault/bindings",
      "List credential vault bindings"
    );
    return sanitizeCredentialBindingListResponse(payload, "List credential vault bindings");
  }
  async getBinding(name) {
    const payload = await this.requestJson(
      "GET",
      `/credential-vault/bindings/${encodeURIComponent(name)}`,
      "Get credential vault binding"
    );
    return sanitizeCredentialBindingMetadata(payload, "Get credential vault binding response");
  }
  async getPolicy() {
    const { data, error, response } = await this.client.GET("/policy");
    throwOnOpenApiFetchError({ error, response }, "Get sandbox egress policy failed");
    const raw = data;
    if (!raw || typeof raw !== "object" || !raw.policy || typeof raw.policy !== "object") {
      throw new Error("Get sandbox egress policy failed: unexpected response shape");
    }
    return raw.policy;
  }
  async patchRules(rules) {
    const body = rules;
    const { error, response } = await this.client.PATCH("/policy", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Patch sandbox egress rules failed");
  }
  async deleteRules(targets) {
    const body = targets;
    const { error, response } = await this.client.DELETE("/policy", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Delete sandbox egress rules failed");
  }
};
function joinUrl2(baseUrl, pathname) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}
function toUploadBlob(data) {
  if (typeof data === "string") return new Blob([data]);
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  const copied = Uint8Array.from(data);
  return new Blob([copied.buffer]);
}
function isReadableStream(v) {
  return !!v && typeof v.getReader === "function";
}
function isAsyncIterable(v) {
  return !!v && typeof v[Symbol.asyncIterator] === "function";
}
function isNodeRuntime() {
  const p = globalThis?.process;
  return !!p?.versions?.node;
}
async function collectBytes(source) {
  const chunks = [];
  let total = 0;
  if (isReadableStream(source)) {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source) {
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function toReadableStream(it) {
  const RS = ReadableStream;
  if (typeof RS?.from === "function") return RS.from(it);
  const iterator = it[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const r = await iterator.next();
      if (r.done) {
        controller.close();
        return;
      }
      controller.enqueue(r.value);
    },
    async cancel() {
      await iterator.return?.();
    }
  });
}
function basename(p) {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "file";
}
function encodeUtf8(s) {
  return new TextEncoder().encode(s);
}
async function* multipartUploadBody(opts) {
  const b = opts.boundary;
  yield encodeUtf8(`--${b}\r
`);
  yield encodeUtf8(
    `Content-Disposition: form-data; name="metadata"; filename="metadata"\r
`
  );
  yield encodeUtf8(`Content-Type: application/json\r
\r
`);
  yield encodeUtf8(opts.metadataJson);
  yield encodeUtf8(`\r
`);
  yield encodeUtf8(`--${b}\r
`);
  yield encodeUtf8(
    `Content-Disposition: form-data; name="file"; filename="${opts.fileName}"\r
`
  );
  yield encodeUtf8(`Content-Type: ${opts.fileContentType}\r
\r
`);
  if (isReadableStream(opts.file)) {
    const reader = opts.file.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of opts.file) {
      yield chunk;
    }
  }
  yield encodeUtf8(`\r
--${b}--\r
`);
}
function toPermission(e) {
  return {
    mode: e.mode ?? 755,
    owner: e.owner,
    group: e.group
  };
}
var FilesystemAdapter = class {
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
  }
  fetch;
  static Api = {
    // This is intentionally derived from OpenAPI schema types so API changes surface quickly.
    SearchFilesOk: null,
    FilesInfoOk: null,
    ListDirectoryOk: null,
    MakeDirsRequest: null,
    SetPermissionsRequest: null,
    MoveFilesRequest: null,
    ReplaceContentsRequest: null,
    ReplaceContentsOk: null
  };
  parseIsoDate(field, v) {
    if (typeof v !== "string" || !v) {
      throw new Error(`Invalid ${field}: expected ISO string, got ${typeof v}`);
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ${field}: ${v}`);
    }
    return d;
  }
  static _ApiFileInfo = null;
  mapApiFileInfo(raw) {
    const { path, type, size, created_at, modified_at, mode, owner, group, ...rest } = raw;
    return {
      ...rest,
      path,
      type,
      size,
      mode,
      owner,
      group,
      createdAt: created_at ? this.parseIsoDate("createdAt", created_at) : void 0,
      modifiedAt: modified_at ? this.parseIsoDate("modifiedAt", modified_at) : void 0
    };
  }
  async getFileInfo(paths) {
    const { data, error, response } = await this.client.GET("/files/info", {
      params: { query: { path: paths } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get file info failed");
    const raw = data;
    if (!raw) return {};
    if (typeof raw !== "object") {
      throw new Error(
        `Get file info failed: unexpected response shape (got ${typeof raw})`
      );
    }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== "object") {
        throw new Error(
          `Get file info failed: invalid file info for path=${k}`
        );
      }
      out[k] = this.mapApiFileInfo(v);
    }
    return out;
  }
  async deleteFiles(paths) {
    const { error, response } = await this.client.DELETE("/files", {
      params: { query: { path: paths } }
    });
    throwOnOpenApiFetchError({ error, response }, "Delete files failed");
  }
  async createDirectories(entries) {
    const map = {};
    for (const e of entries) {
      map[e.path] = toPermission(e);
    }
    const body = map;
    const { error, response } = await this.client.POST("/directories", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Create directories failed");
  }
  async deleteDirectories(paths) {
    const { error, response } = await this.client.DELETE("/directories", {
      params: { query: { path: paths } }
    });
    throwOnOpenApiFetchError({ error, response }, "Delete directories failed");
  }
  async listDirectory(entry) {
    const { data, error, response } = await this.client.GET("/directories/list", {
      params: { query: { path: entry.path, depth: entry.depth } }
    });
    throwOnOpenApiFetchError({ error, response }, "List directory failed");
    const ok = data;
    if (!ok) return [];
    if (!Array.isArray(ok)) {
      throw new Error(
        `List directory failed: unexpected response shape (expected array, got ${typeof ok})`
      );
    }
    return ok.map((x) => this.mapApiFileInfo(x));
  }
  async setPermissions(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = toPermission(e);
    }
    const body = req;
    const { error, response } = await this.client.POST("/files/permissions", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Set permissions failed");
  }
  async moveFiles(entries) {
    const req = entries.map((e) => ({
      src: e.src,
      dest: e.dest
    }));
    const body = req;
    const { error, response } = await this.client.POST("/files/mv", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Move files failed");
  }
  async replaceContents(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = { old: e.oldContent, new: e.newContent };
    }
    const body = req;
    const { error, response } = await this.client.POST("/files/replace", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Replace contents failed");
  }
  async replaceContentsDetailed(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = { old: e.oldContent, new: e.newContent };
    }
    const body = req;
    const { data, error, response } = await this.client.POST("/files/replace", {
      params: { query: { verbose: true } },
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Replace contents failed");
    const ok = data;
    if (!ok) return [];
    return Object.entries(ok).map(([path, result]) => ({
      path,
      replacedCount: result.replacedCount
    }));
  }
  async search(entry) {
    const { data, error, response } = await this.client.GET("/files/search", {
      params: { query: { path: entry.path, pattern: entry.pattern } }
    });
    throwOnOpenApiFetchError({ error, response }, "Search files failed");
    const ok = data;
    if (!ok) return [];
    if (!Array.isArray(ok)) {
      throw new Error(
        `Search files failed: unexpected response shape (expected array, got ${typeof ok})`
      );
    }
    return ok.map((x) => this.mapApiFileInfo(x));
  }
  async uploadFile(meta, data) {
    const url = joinUrl2(this.opts.baseUrl, "/files/upload");
    const fileName = basename(meta.path);
    const metadataJson = JSON.stringify(meta);
    if (isReadableStream(data) || isAsyncIterable(data)) {
      if (!isNodeRuntime()) {
        const bytes = await collectBytes(data);
        return await this.uploadFile(meta, bytes);
      }
      const boundary = `opensandbox_${Math.random().toString(16).slice(2)}_${Date.now()}`;
      const bodyIt = multipartUploadBody({
        boundary,
        metadataJson,
        fileName,
        fileContentType: "application/octet-stream",
        file: data
      });
      const stream = toReadableStream(bodyIt);
      const res2 = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          ...this.opts.headers ?? {}
        },
        body: stream,
        // Node fetch (undici) requires duplex for streaming request bodies.
        duplex: "half"
      });
      if (!res2.ok) {
        const requestId = res2.headers.get("x-request-id") ?? void 0;
        const rawBody = await res2.text().catch(() => void 0);
        throw new SandboxApiException({
          message: `Upload failed (status=${res2.status})`,
          statusCode: res2.status,
          requestId,
          error: new SandboxError(
            SandboxError.UNEXPECTED_RESPONSE,
            "Upload failed"
          ),
          rawBody
        });
      }
      return;
    }
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([metadataJson], { type: "application/json" }),
      "metadata"
    );
    if (typeof data === "string") {
      const textBlob = new Blob([data], { type: "text/plain; charset=utf-8" });
      form.append("file", textBlob, fileName);
    } else {
      const blob = toUploadBlob(data);
      const fileBlob = blob.type ? blob : new Blob([blob], { type: "application/octet-stream" });
      form.append("file", fileBlob, fileName);
    }
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        ...this.opts.headers ?? {}
      },
      body: form
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: `Upload failed (status=${res.status})`,
        statusCode: res.status,
        requestId,
        error: new SandboxError(
          SandboxError.UNEXPECTED_RESPONSE,
          "Upload failed"
        ),
        rawBody
      });
    }
  }
  async readBytes(path, opts) {
    let url = joinUrl2(this.opts.baseUrl, "/files/download") + `?path=${encodeURIComponent(path)}`;
    if (opts?.offset != null) url += `&offset=${opts.offset}`;
    if (opts?.limit != null) url += `&limit=${opts.limit}`;
    const res = await this.fetch(url, {
      method: "GET",
      headers: {
        ...this.opts.headers ?? {},
        ...opts?.range ? { Range: opts.range } : {}
      }
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: "Download failed",
        statusCode: res.status,
        requestId,
        error: new SandboxError(
          SandboxError.UNEXPECTED_RESPONSE,
          "Download failed"
        ),
        rawBody
      });
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
  readBytesStream(path, opts) {
    return this.downloadStream(path, opts);
  }
  async *downloadStream(path, opts) {
    let url = joinUrl2(this.opts.baseUrl, "/files/download") + `?path=${encodeURIComponent(path)}`;
    if (opts?.offset != null) url += `&offset=${opts.offset}`;
    if (opts?.limit != null) url += `&limit=${opts.limit}`;
    const res = await this.fetch(url, {
      method: "GET",
      headers: {
        ...this.opts.headers ?? {},
        ...opts?.range ? { Range: opts.range } : {}
      }
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: "Download stream failed",
        statusCode: res.status,
        requestId,
        error: new SandboxError(
          SandboxError.UNEXPECTED_RESPONSE,
          "Download stream failed"
        ),
        rawBody
      });
    }
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  async readFile(path, opts) {
    const bytes = await this.readBytes(path, { range: opts?.range, offset: opts?.offset, limit: opts?.limit });
    const encoding = opts?.encoding ?? "utf-8";
    return new TextDecoder(encoding).decode(bytes);
  }
  async writeFiles(entries) {
    for (const e of entries) {
      const meta = {
        path: e.path,
        owner: e.owner,
        group: e.group,
        mode: e.mode
      };
      await this.uploadFile(meta, e.data ?? "");
    }
  }
};
var HealthAdapter = class {
  constructor(client) {
    this.client = client;
  }
  async ping() {
    const { error, response } = await this.client.GET("/ping", { parseAs: "text" });
    throwOnOpenApiFetchError({ error, response }, "Execd ping failed");
    return true;
  }
};
function joinUrl3(baseUrl, pathname) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}
function toUploadBlob2(data) {
  if (typeof data === "string") return new Blob([data]);
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  const copied = Uint8Array.from(data);
  return new Blob([copied.buffer]);
}
function isReadableStream2(v) {
  return !!v && typeof v.getReader === "function";
}
function isAsyncIterable2(v) {
  return !!v && typeof v[Symbol.asyncIterator] === "function";
}
async function collectBytes2(source) {
  const chunks = [];
  let total = 0;
  if (isReadableStream2(source)) {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source) {
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function basename2(p) {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "file";
}
function toPermission2(e) {
  return {
    mode: e.mode ?? 755,
    owner: e.owner,
    group: e.group
  };
}
var IsolatedFilesystemAdapter = class {
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
    this.sessionId = opts.sessionId;
  }
  fetch;
  sessionId;
  static Api = {
    SearchFilesOk: null,
    FilesInfoOk: null,
    ListDirectoryOk: null
  };
  parseIsoDate(field, v) {
    if (typeof v !== "string" || !v) {
      throw new Error(`Invalid ${field}: expected ISO string, got ${typeof v}`);
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ${field}: ${v}`);
    }
    return d;
  }
  static _ApiFileInfo = null;
  mapApiFileInfo(raw) {
    const { path, type, size, created_at, modified_at, mode, owner, group, ...rest } = raw;
    return {
      ...rest,
      path,
      type,
      size,
      mode,
      owner,
      group,
      createdAt: created_at ? this.parseIsoDate("createdAt", created_at) : void 0,
      modifiedAt: modified_at ? this.parseIsoDate("modifiedAt", modified_at) : void 0
    };
  }
  async getFileInfo(paths) {
    const { data, error, response } = await this.client.GET(
      "/v1/isolated/session/{sessionId}/files/info",
      { params: { path: { sessionId: this.sessionId }, query: { path: paths } } }
    );
    throwOnOpenApiFetchError({ error, response }, "Get file info failed");
    const raw = data;
    if (!raw) return {};
    if (typeof raw !== "object") {
      throw new Error(`Get file info failed: unexpected response shape (got ${typeof raw})`);
    }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== "object") {
        throw new Error(`Get file info failed: invalid file info for path=${k}`);
      }
      out[k] = this.mapApiFileInfo(v);
    }
    return out;
  }
  async deleteFiles(paths) {
    const { error, response } = await this.client.DELETE(
      "/v1/isolated/session/{sessionId}/files",
      { params: { path: { sessionId: this.sessionId }, query: { path: paths } } }
    );
    throwOnOpenApiFetchError({ error, response }, "Delete files failed");
  }
  async createDirectories(entries) {
    const map = {};
    for (const e of entries) {
      map[e.path] = toPermission2(e);
    }
    const { error, response } = await this.client.POST(
      "/v1/isolated/session/{sessionId}/directories",
      {
        params: { path: { sessionId: this.sessionId } },
        body: map
      }
    );
    throwOnOpenApiFetchError({ error, response }, "Create directories failed");
  }
  async deleteDirectories(paths) {
    const { error, response } = await this.client.DELETE(
      "/v1/isolated/session/{sessionId}/directories",
      { params: { path: { sessionId: this.sessionId }, query: { path: paths } } }
    );
    throwOnOpenApiFetchError({ error, response }, "Delete directories failed");
  }
  async listDirectory(entry) {
    const { data, error, response } = await this.client.GET(
      "/v1/isolated/session/{sessionId}/directories/list",
      { params: { path: { sessionId: this.sessionId }, query: { path: entry.path, depth: entry.depth } } }
    );
    throwOnOpenApiFetchError({ error, response }, "List directory failed");
    const ok = data;
    if (!ok) return [];
    if (!Array.isArray(ok)) {
      throw new Error(`List directory failed: unexpected response shape (expected array, got ${typeof ok})`);
    }
    return ok.map((x) => this.mapApiFileInfo(x));
  }
  async setPermissions(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = toPermission2(e);
    }
    const { error, response } = await this.client.POST(
      "/v1/isolated/session/{sessionId}/files/permissions",
      {
        params: { path: { sessionId: this.sessionId } },
        body: req
      }
    );
    throwOnOpenApiFetchError({ error, response }, "Set permissions failed");
  }
  async moveFiles(entries) {
    const req = entries.map((e) => ({ src: e.src, dest: e.dest }));
    const { error, response } = await this.client.POST(
      "/v1/isolated/session/{sessionId}/files/mv",
      {
        params: { path: { sessionId: this.sessionId } },
        body: req
      }
    );
    throwOnOpenApiFetchError({ error, response }, "Move files failed");
  }
  async replaceContents(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = { old: e.oldContent, new: e.newContent };
    }
    const { error, response } = await this.client.POST(
      "/v1/isolated/session/{sessionId}/files/replace",
      {
        params: { path: { sessionId: this.sessionId } },
        body: req
      }
    );
    throwOnOpenApiFetchError({ error, response }, "Replace contents failed");
  }
  async replaceContentsDetailed(entries) {
    const req = {};
    for (const e of entries) {
      req[e.path] = { old: e.oldContent, new: e.newContent };
    }
    const { data, error, response } = await this.client.POST(
      "/v1/isolated/session/{sessionId}/files/replace",
      {
        params: { path: { sessionId: this.sessionId } },
        body: req
      }
    );
    throwOnOpenApiFetchError({ error, response }, "Replace contents failed");
    if (!data) return [];
    return Object.entries(data).map(([path, result]) => ({
      path,
      replacedCount: result.replacedCount
    }));
  }
  async search(entry) {
    const { data, error, response } = await this.client.GET(
      "/v1/isolated/session/{sessionId}/files/search",
      { params: { path: { sessionId: this.sessionId }, query: { path: entry.path, pattern: entry.pattern } } }
    );
    throwOnOpenApiFetchError({ error, response }, "Search files failed");
    const ok = data;
    if (!ok) return [];
    if (!Array.isArray(ok)) {
      throw new Error(`Search files failed: unexpected response shape (expected array, got ${typeof ok})`);
    }
    return ok.map((x) => this.mapApiFileInfo(x));
  }
  async uploadFile(meta, data) {
    if (isReadableStream2(data) || isAsyncIterable2(data)) {
      const bytes = await collectBytes2(data);
      return await this.uploadFile(meta, bytes);
    }
    const url = joinUrl3(
      this.opts.baseUrl,
      `/v1/isolated/session/${encodeURIComponent(this.sessionId)}/files/upload`
    );
    const fileName = basename2(meta.path);
    const metadataJson = JSON.stringify(meta);
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([metadataJson], { type: "application/json" }),
      "metadata"
    );
    if (typeof data === "string") {
      form.append("file", new Blob([data], { type: "text/plain; charset=utf-8" }), fileName);
    } else {
      const blob = toUploadBlob2(data);
      const fileBlob = blob.type ? blob : new Blob([blob], { type: "application/octet-stream" });
      form.append("file", fileBlob, fileName);
    }
    const res = await this.fetch(url, {
      method: "POST",
      headers: { ...this.opts.headers ?? {} },
      body: form
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: `Upload failed (status=${res.status})`,
        statusCode: res.status,
        requestId,
        error: new SandboxError(SandboxError.UNEXPECTED_RESPONSE, "Upload failed"),
        rawBody
      });
    }
  }
  async readBytes(path, opts) {
    let url = joinUrl3(
      this.opts.baseUrl,
      `/v1/isolated/session/${encodeURIComponent(this.sessionId)}/files/download`
    ) + `?path=${encodeURIComponent(path)}`;
    if (opts?.offset != null) url += `&offset=${opts.offset}`;
    if (opts?.limit != null) url += `&limit=${opts.limit}`;
    const res = await this.fetch(url, {
      method: "GET",
      headers: {
        ...this.opts.headers ?? {},
        ...opts?.range ? { Range: opts.range } : {}
      }
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: "Download failed",
        statusCode: res.status,
        requestId,
        error: new SandboxError(SandboxError.UNEXPECTED_RESPONSE, "Download failed"),
        rawBody
      });
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
  readBytesStream(path, opts) {
    return this.downloadStream(path, opts);
  }
  async *downloadStream(path, opts) {
    let url = joinUrl3(
      this.opts.baseUrl,
      `/v1/isolated/session/${encodeURIComponent(this.sessionId)}/files/download`
    ) + `?path=${encodeURIComponent(path)}`;
    if (opts?.offset != null) url += `&offset=${opts.offset}`;
    if (opts?.limit != null) url += `&limit=${opts.limit}`;
    const res = await this.fetch(url, {
      method: "GET",
      headers: {
        ...this.opts.headers ?? {},
        ...opts?.range ? { Range: opts.range } : {}
      }
    });
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? void 0;
      const rawBody = await res.text().catch(() => void 0);
      throw new SandboxApiException({
        message: "Download stream failed",
        statusCode: res.status,
        requestId,
        error: new SandboxError(SandboxError.UNEXPECTED_RESPONSE, "Download stream failed"),
        rawBody
      });
    }
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  async readFile(path, opts) {
    const bytes = await this.readBytes(path, { range: opts?.range, offset: opts?.offset, limit: opts?.limit });
    const encoding = opts?.encoding ?? "utf-8";
    return new TextDecoder(encoding).decode(bytes);
  }
  async writeFiles(entries) {
    for (const e of entries) {
      const meta = {
        path: e.path,
        owner: e.owner,
        group: e.group,
        mode: e.mode
      };
      await this.uploadFile(meta, e.data ?? "");
    }
  }
};
function joinUrl4(baseUrl, pathname) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}
function assertNonBlank2(value, field) {
  if (!value.trim()) {
    throw new Error(`${field} cannot be empty`);
  }
}
function inferExitCode(execution) {
  const errorValue = execution.error?.value?.trim();
  const parsedExitCode = errorValue && /^-?\d+$/.test(errorValue) ? Number(errorValue) : Number.NaN;
  return execution.error != null ? Number.isFinite(parsedExitCode) ? parsedExitCode : null : execution.complete ? 0 : null;
}
var IsolationSessionHandle = class {
  constructor(_info, adapter) {
    this._info = _info;
    this.adapter = adapter;
  }
  _files;
  get sessionId() {
    return this._info.session_id;
  }
  get info() {
    return this._info;
  }
  get files() {
    if (!this._files) {
      const client = createExecdClient({
        baseUrl: this.adapter.opts.baseUrl,
        headers: this.adapter.opts.headers,
        fetch: this.adapter.opts.fetch
      });
      this._files = new IsolatedFilesystemAdapter(client, {
        baseUrl: this.adapter.opts.baseUrl,
        sessionId: this._info.session_id,
        fetch: this.adapter.opts.fetch,
        headers: this.adapter.opts.headers
      });
    }
    return this._files;
  }
  run(code, opts, handlers, signal) {
    return this.adapter._run(this._info.session_id, code, opts, handlers, signal);
  }
  get() {
    return this.adapter._get(this._info.session_id);
  }
  delete() {
    return this.adapter._delete(this._info.session_id);
  }
};
var IsolatedSessionsAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
    this.sseFetch = opts.sseFetch ?? this.fetch;
  }
  fetch;
  sseFetch;
  async jsonRequest(method, pathname, body) {
    const url = joinUrl4(this.opts.baseUrl, pathname);
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...this.opts.headers ?? {}
    };
    const res = await this.fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      throw new Error(`${method} ${pathname} failed: ${res.status} ${text2}`);
    }
    if (res.status === 204) return void 0;
    const text = await res.text();
    if (!text) return void 0;
    return JSON.parse(text);
  }
  async create(request) {
    const info = await this.jsonRequest(
      "POST",
      "/v1/isolated/session",
      request
    );
    return new IsolationSessionHandle(info, this);
  }
  async attach(sessionId) {
    assertNonBlank2(sessionId, "sessionId");
    const state = await this.jsonRequest(
      "GET",
      `/v1/isolated/session/${encodeURIComponent(sessionId)}`
    );
    const info = {
      session_id: sessionId,
      created_at: state.created_at ?? ""
    };
    if (state.profile !== void 0) info.profile = state.profile;
    if (state.workspace !== void 0) info.workspace = state.workspace;
    if (state.extra_writable !== void 0) info.extra_writable = state.extra_writable;
    if (state.binds !== void 0) info.binds = state.binds;
    if (state.share_net !== void 0) info.share_net = state.share_net;
    if (state.env_passthrough !== void 0) info.env_passthrough = state.env_passthrough;
    if (state.uid !== void 0) info.uid = state.uid;
    if (state.gid !== void 0) info.gid = state.gid;
    if (state.uid_mode !== void 0) info.uid_mode = state.uid_mode;
    if (state.idle_timeout_seconds !== void 0) {
      info.idle_timeout_seconds = state.idle_timeout_seconds;
    }
    return new IsolationSessionHandle(info, this);
  }
  async _get(sessionId) {
    assertNonBlank2(sessionId, "sessionId");
    return this.jsonRequest(
      "GET",
      `/v1/isolated/session/${encodeURIComponent(sessionId)}`
    );
  }
  async _run(sessionId, code, opts, handlers, signal) {
    assertNonBlank2(sessionId, "sessionId");
    assertNonBlank2(code, "code");
    const body = { code };
    if (opts?.envs) body.envs = opts.envs;
    if (opts?.timeout_seconds != null) body.timeout_seconds = opts.timeout_seconds;
    const url = joinUrl4(
      this.opts.baseUrl,
      `/v1/isolated/session/${encodeURIComponent(sessionId)}/run`
    );
    const res = await this.sseFetch(url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...this.opts.headers ?? {}
      },
      body: JSON.stringify(body),
      signal
    });
    const execution = {
      logs: { stdout: [], stderr: [] },
      result: []
    };
    const dispatcher = new ExecutionEventDispatcher(execution, handlers);
    for await (const ev of parseJsonEventStream(res, {
      fallbackErrorMessage: "Run in isolated session failed"
    })) {
      await dispatcher.dispatch(ev);
    }
    execution.exitCode = inferExitCode(execution);
    return execution;
  }
  async _delete(sessionId) {
    assertNonBlank2(sessionId, "sessionId");
    await this.jsonRequest(
      "DELETE",
      `/v1/isolated/session/${encodeURIComponent(sessionId)}`
    );
  }
  async capabilities() {
    const response = await this.jsonRequest(
      "GET",
      "/v1/isolated/capabilities"
    );
    return {
      ...response,
      setpriv_available: response.setpriv_available ?? false,
      userns_available: response.userns_available ?? false
    };
  }
  async list() {
    const resp = await this.jsonRequest(
      "GET",
      "/v1/isolated/sessions"
    );
    return resp.sessions ?? [];
  }
  async runOnce(code, workspace, opts) {
    const session = await this.create({
      workspace: { path: workspace, mode: opts?.workspaceMode },
      profile: opts?.profile,
      share_net: opts?.shareNet,
      binds: opts?.binds
    });
    try {
      return await session.run(code, opts?.runOpts, opts?.handlers, opts?.signal);
    } finally {
      try {
        await session.delete();
      } catch {
      }
    }
  }
  async withSession(request, fn) {
    const session = await this.create(request);
    try {
      return await fn(session);
    } finally {
      try {
        await session.delete();
      } catch {
      }
    }
  }
};
function normalizeMetrics(m) {
  const cpuCount = m.cpu_count ?? 0;
  const cpuUsedPercentage = m.cpu_used_pct ?? 0;
  const memoryTotalMiB = m.mem_total_mib ?? 0;
  const memoryUsedMiB = m.mem_used_mib ?? 0;
  const timestamp = m.timestamp ?? 0;
  return {
    cpuCount: Number(cpuCount),
    cpuUsedPercentage: Number(cpuUsedPercentage),
    memoryTotalMiB: Number(memoryTotalMiB),
    memoryUsedMiB: Number(memoryUsedMiB),
    timestamp: Number(timestamp)
  };
}
var MetricsAdapter = class {
  constructor(client) {
    this.client = client;
  }
  async getMetrics() {
    const { data, error, response } = await this.client.GET("/metrics");
    throwOnOpenApiFetchError({ error, response }, "Get execd metrics failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Get execd metrics failed: unexpected response shape");
    }
    return normalizeMetrics(ok);
  }
};
var EndpointCache = class {
  cache = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  maxSize;
  ttlMs;
  generation = 0;
  constructor(opts = {}) {
    this.maxSize = opts.maxSize ?? 1024;
    this.ttlMs = opts.ttlMs ?? 6e5;
  }
  cloneEndpoint(ep) {
    return { ...ep, headers: ep.headers ? { ...ep.headers } : {} };
  }
  makeKey(sandboxId, port, useServerProxy) {
    return `${sandboxId}:${port}:${useServerProxy}`;
  }
  get(sandboxId, port, useServerProxy) {
    const key = this.makeKey(sandboxId, port, useServerProxy);
    const entry = this.cache.get(key);
    if (!entry) return void 0;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return void 0;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return this.cloneEndpoint(entry.endpoint);
  }
  put(sandboxId, port, useServerProxy, endpoint) {
    const key = this.makeKey(sandboxId, port, useServerProxy);
    this.cache.delete(key);
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== void 0) this.cache.delete(oldest);
      else break;
    }
    this.cache.set(key, { endpoint: this.cloneEndpoint(endpoint), expiresAt: Date.now() + this.ttlMs });
  }
  invalidate(sandboxId) {
    this.generation++;
    const prefix = `${sandboxId}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (key.startsWith(prefix)) {
        this.inflight.delete(key);
      }
    }
  }
  async getOrFetch(sandboxId, port, useServerProxy, fetcher) {
    const cached = this.get(sandboxId, port, useServerProxy);
    if (cached) return cached;
    const key = this.makeKey(sandboxId, port, useServerProxy);
    const existing = this.inflight.get(key);
    if (existing) return existing.then((ep) => this.cloneEndpoint(ep));
    const genBefore = this.generation;
    const promise = fetcher().then((ep) => {
      if (this.generation === genBefore) {
        this.put(sandboxId, port, useServerProxy, ep);
      }
      this.inflight.delete(key);
      return this.cloneEndpoint(ep);
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });
    this.inflight.set(key, promise);
    return promise;
  }
  get size() {
    return this.cache.size;
  }
};
function encodeMetadataFilter(metadata) {
  const parts = [];
  for (const [k, v] of Object.entries(metadata)) {
    parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}
var SandboxesAdapter = class {
  constructor(client, cacheOpts) {
    this.client = client;
    if (cacheOpts?.disabled) {
      this.endpointCache = null;
    } else {
      this.endpointCache = new EndpointCache({
        ttlMs: cacheOpts?.ttlMs,
        maxSize: cacheOpts?.maxSize
      });
    }
  }
  endpointCache;
  parseIsoDate(field, v) {
    if (typeof v !== "string" || !v) {
      throw new Error(`Invalid ${field}: expected ISO string, got ${typeof v}`);
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ${field}: ${v}`);
    }
    return d;
  }
  parseOptionalIsoDate(field, v) {
    if (v == null) return null;
    return this.parseIsoDate(field, v);
  }
  mapSnapshotInfo(raw) {
    return {
      ...raw ?? {},
      createdAt: this.parseIsoDate("createdAt", raw?.createdAt),
      status: {
        ...raw?.status ?? {},
        lastTransitionAt: raw?.status?.lastTransitionAt == null ? void 0 : this.parseIsoDate("lastTransitionAt", raw.status.lastTransitionAt)
      }
    };
  }
  mapSandboxInfo(raw) {
    return {
      ...raw ?? {},
      createdAt: this.parseIsoDate("createdAt", raw?.createdAt),
      expiresAt: this.parseOptionalIsoDate("expiresAt", raw?.expiresAt)
    };
  }
  async createSandbox(req) {
    const body = req;
    const { data, error, response } = await this.client.POST("/sandboxes", {
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Create sandbox failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("Create sandbox failed: unexpected response shape");
    }
    return {
      ...raw ?? {},
      createdAt: this.parseIsoDate("createdAt", raw?.createdAt),
      expiresAt: this.parseOptionalIsoDate("expiresAt", raw?.expiresAt)
    };
  }
  async getSandbox(sandboxId) {
    const { data, error, response } = await this.client.GET("/sandboxes/{sandboxId}", {
      params: { path: { sandboxId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get sandbox failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Get sandbox failed: unexpected response shape");
    }
    return this.mapSandboxInfo(ok);
  }
  async listSandboxes(params = {}) {
    const query = {};
    if (params.states?.length) query.state = params.states;
    if (params.metadata && Object.keys(params.metadata).length) {
      query.metadata = encodeMetadataFilter(params.metadata);
    }
    if (params.page != null) query.page = params.page;
    if (params.pageSize != null) query.pageSize = params.pageSize;
    const { data, error, response } = await this.client.GET("/sandboxes", {
      params: { query }
    });
    throwOnOpenApiFetchError({ error, response }, "List sandboxes failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("List sandboxes failed: unexpected response shape");
    }
    const itemsRaw = raw.items;
    if (!Array.isArray(itemsRaw)) throw new Error("List sandboxes failed: unexpected items shape");
    return {
      ...raw ?? {},
      items: itemsRaw.map((x) => this.mapSandboxInfo(x))
    };
  }
  async patchSandboxMetadata(sandboxId, patch) {
    const body = patch;
    const { data, error, response } = await this.client.PATCH("/sandboxes/{sandboxId}/metadata", {
      params: { path: { sandboxId } },
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Patch sandbox metadata failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Patch sandbox metadata failed: unexpected response shape");
    }
    return this.mapSandboxInfo(ok);
  }
  async deleteSandbox(sandboxId) {
    const { error, response } = await this.client.DELETE("/sandboxes/{sandboxId}", {
      params: { path: { sandboxId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Delete sandbox failed");
  }
  async pauseSandbox(sandboxId) {
    const { error, response } = await this.client.POST("/sandboxes/{sandboxId}/pause", {
      params: { path: { sandboxId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Pause sandbox failed");
  }
  async resumeSandbox(sandboxId) {
    const { error, response } = await this.client.POST("/sandboxes/{sandboxId}/resume", {
      params: { path: { sandboxId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Resume sandbox failed");
  }
  async renewSandboxExpiration(sandboxId, req) {
    const body = req;
    const { data, error, response } = await this.client.POST("/sandboxes/{sandboxId}/renew-expiration", {
      params: { path: { sandboxId } },
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Renew sandbox expiration failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("Renew sandbox expiration failed: unexpected response shape");
    }
    return {
      ...raw ?? {},
      expiresAt: raw?.expiresAt ? this.parseIsoDate("expiresAt", raw.expiresAt) : void 0
    };
  }
  async createSnapshot(sandboxId, req = {}) {
    const body = req;
    const { data, error, response } = await this.client.POST("/sandboxes/{sandboxId}/snapshots", {
      params: { path: { sandboxId } },
      body
    });
    throwOnOpenApiFetchError({ error, response }, "Create snapshot failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("Create snapshot failed: unexpected response shape");
    }
    return this.mapSnapshotInfo(raw);
  }
  async getSnapshot(snapshotId) {
    const { data, error, response } = await this.client.GET("/snapshots/{snapshotId}", {
      params: { path: { snapshotId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get snapshot failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("Get snapshot failed: unexpected response shape");
    }
    return this.mapSnapshotInfo(raw);
  }
  async listSnapshots(params = {}) {
    const query = {};
    if (params.sandboxId) query.sandboxId = params.sandboxId;
    if (params.name != null) query.name = params.name;
    if (params.states?.length) query.state = params.states;
    if (params.page != null) query.page = params.page;
    if (params.pageSize != null) query.pageSize = params.pageSize;
    const { data, error, response } = await this.client.GET("/snapshots", {
      params: { query }
    });
    throwOnOpenApiFetchError({ error, response }, "List snapshots failed");
    const raw = data;
    if (!raw || typeof raw !== "object") {
      throw new Error("List snapshots failed: unexpected response shape");
    }
    const itemsRaw = raw.items;
    if (!Array.isArray(itemsRaw)) throw new Error("List snapshots failed: unexpected items shape");
    return {
      ...raw ?? {},
      items: itemsRaw.map((x) => this.mapSnapshotInfo(x))
    };
  }
  async deleteSnapshot(snapshotId) {
    const { error, response } = await this.client.DELETE("/snapshots/{snapshotId}", {
      params: { path: { snapshotId } }
    });
    throwOnOpenApiFetchError({ error, response }, "Delete snapshot failed");
  }
  async getSandboxEndpoint(sandboxId, port, useServerProxy = false) {
    if (this.endpointCache) {
      return this.endpointCache.getOrFetch(
        sandboxId,
        port,
        useServerProxy,
        () => this.fetchSandboxEndpoint(sandboxId, port, useServerProxy)
      );
    }
    return this.fetchSandboxEndpoint(sandboxId, port, useServerProxy);
  }
  async fetchSandboxEndpoint(sandboxId, port, useServerProxy) {
    const { data, error, response } = await this.client.GET("/sandboxes/{sandboxId}/endpoints/{port}", {
      params: { path: { sandboxId, port }, query: { use_server_proxy: useServerProxy } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get sandbox endpoint failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Get sandbox endpoint failed: unexpected response shape");
    }
    return ok;
  }
  invalidateEndpointCache(sandboxId) {
    this.endpointCache?.invalidate(sandboxId);
  }
  async getSignedEndpoint(sandboxId, port, expires) {
    const { data, error, response } = await this.client.GET("/sandboxes/{sandboxId}/endpoints/{port}", {
      params: { path: { sandboxId, port }, query: { expires: expires.toString() } }
    });
    throwOnOpenApiFetchError({ error, response }, "Get signed endpoint failed");
    const ok = data;
    if (!ok || typeof ok !== "object") {
      throw new Error("Get signed endpoint failed: unexpected response shape");
    }
    return ok;
  }
};
var DEFAULT_EXECD_PORT = 44772;
var DEFAULT_EGRESS_PORT = 18080;
var DEFAULT_ENTRYPOINT = ["tail", "-f", "/dev/null"];
var DEFAULT_RESOURCE_LIMITS = {
  cpu: "1",
  memory: "2Gi"
};
var DEFAULT_TIMEOUT_SECONDS = 600;
var DEFAULT_READY_TIMEOUT_SECONDS = 30;
var DEFAULT_HEALTH_CHECK_POLLING_INTERVAL_MILLIS = 200;
var DEFAULT_USER_AGENT = "OpenSandbox-JS-SDK/0.1.11";
var CLIENT_IP_HEADER = "OPEN-SANDBOX-CLIENT-IP";
var VIRTUAL_NIC_PREFIXES = [
  "docker",
  "veth",
  "br-",
  "virbr",
  "vmnet",
  "vbox",
  "utun",
  "tun",
  "tap",
  "zt",
  "cni",
  "flannel",
  "cali"
];
var cachedIp = "";
var detectionStarted = false;
var detectionPromise = null;
function isNodeRuntime2() {
  const p = globalThis?.process;
  return !!p?.versions?.node;
}
function isVirtualNic(name) {
  const lower = name.toLowerCase();
  return VIRTUAL_NIC_PREFIXES.some((p) => lower.startsWith(p));
}
function nicNameRank(rawName) {
  const name = rawName.toLowerCase();
  if (name === "en0") return 0;
  if (name === "eth0") return 1;
  if (name.startsWith("eth")) return 2;
  if (name.startsWith("en")) return 3;
  if (name.startsWith("bond")) return 4;
  return 100;
}
function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}
function isUsableIpv4(ip) {
  const o = parseIpv4(ip);
  if (!o) return false;
  if (o[0] === 127) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  if (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return false;
  return true;
}
function isPrivateIpv4(ip) {
  const o = parseIpv4(ip);
  if (!o) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}
function selectClientIp(nics) {
  let best = "";
  let bestRank = 0;
  let bestPrivate = false;
  let found = false;
  for (const nic of nics) {
    if (isVirtualNic(nic.name)) continue;
    const rank = nicNameRank(nic.name);
    for (const ip of nic.ips) {
      if (!isUsableIpv4(ip)) continue;
      const priv = isPrivateIpv4(ip);
      if (!found || rank < bestRank || rank === bestRank && priv && !bestPrivate) {
        best = ip;
        bestRank = rank;
        bestPrivate = priv;
        found = true;
      }
    }
  }
  return best;
}
async function detectOutboundIp() {
  if (!isNodeRuntime2()) return "";
  try {
    const specifier = "node:os";
    const os = await import(specifier);
    const raw = os.networkInterfaces();
    const nics = [];
    for (const [name, addrs] of Object.entries(raw)) {
      if (!addrs) continue;
      const ips = addrs.filter((a) => !a.internal && (a.family === "IPv4" || a.family === 4) && a.address).map((a) => a.address);
      if (ips.length) nics.push({ name, ips });
    }
    return selectClientIp(nics);
  } catch {
    return "";
  }
}
function ensureDetectionStarted() {
  if (detectionStarted || !isNodeRuntime2()) return;
  detectionStarted = true;
  detectionPromise = detectOutboundIp().then((ip) => {
    cachedIp = ip;
  }).catch(() => {
  });
}
ensureDetectionStarted();
async function ensureClientIpReady() {
  if (detectionPromise) {
    try {
      await detectionPromise;
    } catch {
    }
  }
}
function getClientIp() {
  return cachedIp;
}
function withClientIp(input, init) {
  const ip = getClientIp();
  if (!ip) return { input, init };
  const inputIsRequest = typeof Request !== "undefined" && input instanceof Request;
  const headers = new Headers(inputIsRequest ? input.headers : void 0);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  if (!headers.has(CLIENT_IP_HEADER)) {
    headers.set(CLIENT_IP_HEADER, ip);
  }
  if (inputIsRequest) {
    return {
      input: new Request(input, { headers }),
      init: { ...init ?? {}, headers }
    };
  }
  return { input, init: { ...init ?? {}, headers } };
}

// node_modules/@alibaba-group/opensandbox/dist/index.js
var DefaultAdapterFactory = class {
  createLifecycleStack(opts) {
    const lifecycleClient = createLifecycleClient({
      baseUrl: opts.lifecycleBaseUrl,
      apiKey: opts.connectionConfig.apiKey,
      headers: opts.connectionConfig.headers,
      fetch: opts.connectionConfig.fetch
    });
    const sandboxes = new SandboxesAdapter(lifecycleClient, {
      ttlMs: opts.connectionConfig.endpointCacheTtlMs,
      maxSize: opts.connectionConfig.endpointCacheSize,
      disabled: opts.connectionConfig.endpointCacheDisabled
    });
    return { sandboxes };
  }
  createExecdStack(opts) {
    const headers = {
      ...opts.connectionConfig.headers ?? {},
      ...opts.endpointHeaders ?? {}
    };
    const execdClient = createExecdClient({
      baseUrl: opts.execdBaseUrl,
      headers,
      fetch: opts.connectionConfig.fetch
    });
    const health = new HealthAdapter(execdClient);
    const metrics = new MetricsAdapter(execdClient);
    const files = new FilesystemAdapter(execdClient, {
      baseUrl: opts.execdBaseUrl,
      fetch: opts.connectionConfig.fetch,
      headers
    });
    const commands = new CommandsAdapter(execdClient, {
      baseUrl: opts.execdBaseUrl,
      fetch: opts.connectionConfig.sseFetch,
      headers
    });
    const isolated = new IsolatedSessionsAdapter({
      baseUrl: opts.execdBaseUrl,
      fetch: opts.connectionConfig.fetch,
      sseFetch: opts.connectionConfig.sseFetch,
      headers
    });
    return {
      commands,
      files,
      health,
      metrics,
      isolation: isolated
    };
  }
  createEgressStack(opts) {
    const headers = {
      ...opts.connectionConfig.headers ?? {},
      ...opts.endpointHeaders ?? {}
    };
    const egressClient = createEgressClient({
      baseUrl: opts.egressBaseUrl,
      headers,
      fetch: opts.connectionConfig.fetch
    });
    const egress = new EgressAdapter(egressClient, {
      baseUrl: opts.egressBaseUrl,
      fetch: opts.connectionConfig.fetch,
      headers
    });
    return {
      egress,
      credentialVault: egress
    };
  }
};
function createDefaultAdapterFactory() {
  return new DefaultAdapterFactory();
}
function isNodeRuntime3() {
  const p = globalThis?.process;
  return !!p?.versions?.node;
}
function redactHeaders(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === "open-sandbox-api-key") out[k] = "***";
  }
  return out;
}
function readEnv(name) {
  const env = globalThis?.process?.env;
  const v = env?.[name];
  return typeof v === "string" && v.length ? v : void 0;
}
function stripTrailingSlashes2(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === s.length ? s : s.slice(0, end);
}
function stripV1Suffix(s) {
  const trimmed = stripTrailingSlashes2(s);
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}
var DEFAULT_KEEPALIVE_TIMEOUT_MS = 3e4;
function normalizeDomainBase(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const u = new URL(input);
    const proto = u.protocol === "https:" ? "https" : "http";
    const base = `${u.origin}${u.pathname}`;
    return { protocol: proto, domainBase: stripV1Suffix(base) };
  }
  return { domainBase: stripV1Suffix(input) };
}
function createNodeFetch() {
  if (!isNodeRuntime3()) {
    return {
      fetch,
      close: async () => {
      }
    };
  }
  const baseFetch = fetch;
  let dispatcher;
  let dispatcherPromise = null;
  const nodeFetch = async (input, init) => {
    dispatcherPromise ??= (async () => {
      try {
        const mod = await import("./undici-BHYWOZAG.js");
        const Agent = mod.Agent;
        if (!Agent) {
          return void 0;
        }
        dispatcher = new Agent({
          keepAliveTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
          keepAliveMaxTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS
        });
        return dispatcher;
      } catch {
        return void 0;
      }
    })();
    if (dispatcherPromise) {
      await dispatcherPromise;
    }
    if (dispatcher) {
      const mergedInit = { ...init ?? {}, dispatcher };
      return baseFetch(input, mergedInit);
    }
    return baseFetch(input, init);
  };
  return {
    fetch: nodeFetch,
    close: async () => {
      if (dispatcherPromise) {
        await dispatcherPromise.catch(() => void 0);
      }
      if (dispatcher && typeof dispatcher === "object" && typeof dispatcher.close === "function") {
        try {
          await dispatcher.close();
        } catch {
        }
      }
    }
  };
}
function createTimedFetch(opts) {
  const baseFetch = opts.baseFetch;
  const timeoutSeconds = opts.timeoutSeconds;
  const debug = opts.debug;
  const defaultHeaders = opts.defaultHeaders ?? {};
  const label = opts.label;
  return async (input, init) => {
    const method = init?.method ?? "GET";
    const url = typeof input === "string" ? input : input?.toString?.() ?? String(input);
    const ac = new AbortController();
    const timeoutMs = Math.floor(timeoutSeconds * 1e3);
    const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(
      () => ac.abort(
        new Error(
          `[${label}] Request timed out (timeoutSeconds=${timeoutSeconds})`
        )
      ),
      timeoutMs
    ) : void 0;
    const onAbort = () => ac.abort(init?.signal?.reason ?? new Error("Aborted"));
    if (init?.signal) {
      if (init.signal.aborted) onAbort();
      else
        init.signal.addEventListener("abort", onAbort, { once: true });
    }
    await ensureClientIpReady();
    const withIp = withClientIp(input, init);
    const reqInput = withIp.input;
    const mergedInit = {
      ...withIp.init ?? {},
      signal: ac.signal
    };
    if (debug) {
      const outgoing = new Headers(
        withIp.init?.headers ?? (typeof Request !== "undefined" && reqInput instanceof Request ? reqInput.headers : void 0)
      );
      const mergedHeaders = { ...defaultHeaders };
      outgoing.forEach((value, key) => {
        mergedHeaders[key] = value;
      });
      console.log(
        `[opensandbox:${label}] ->`,
        method,
        url,
        redactHeaders(mergedHeaders)
      );
    }
    try {
      const res = await baseFetch(reqInput, mergedInit);
      if (debug) {
        console.log(`[opensandbox:${label}] <-`, method, url, res.status);
      }
      return res;
    } finally {
      if (t) clearTimeout(t);
      if (init?.signal)
        init.signal.removeEventListener("abort", onAbort);
    }
  };
}
var ConnectionConfig = class _ConnectionConfig {
  protocol;
  domain;
  apiKey;
  headers;
  _fetch;
  _sseFetch;
  requestTimeoutSeconds;
  debug;
  userAgent = DEFAULT_USER_AGENT;
  /**
   * Use sandbox server as proxy for endpoint requests (default false).
   */
  useServerProxy;
  endpointCacheTtlMs;
  endpointCacheSize;
  endpointCacheDisabled;
  disableMetrics;
  _closeTransport;
  _closePromise = null;
  _transportInitialized = false;
  /**
   * Create a connection configuration.
   *
   * Environment variables (optional):
   * - `OPEN_SANDBOX_DOMAIN` (default: `localhost:8080`)
   * - `OPEN_SANDBOX_API_KEY`
   * - `OPENSANDBOX_DISABLE_METRICS=1` to opt out of create-latency telemetry
   */
  constructor(opts = {}) {
    const envDomain = readEnv("OPEN_SANDBOX_DOMAIN");
    const envApiKey = readEnv("OPEN_SANDBOX_API_KEY");
    const rawDomain = opts.domain ?? envDomain ?? "localhost:8080";
    const normalized = normalizeDomainBase(rawDomain);
    this.protocol = normalized.protocol ?? opts.protocol ?? "http";
    this.domain = normalized.domainBase;
    this.apiKey = opts.apiKey ?? envApiKey;
    this.requestTimeoutSeconds = typeof opts.requestTimeoutSeconds === "number" ? opts.requestTimeoutSeconds : 30;
    this.debug = !!opts.debug;
    this.useServerProxy = !!opts.useServerProxy;
    this.endpointCacheTtlMs = opts.endpointCacheTtlMs ?? 6e5;
    this.endpointCacheSize = opts.endpointCacheSize ?? 1024;
    this.endpointCacheDisabled = !!opts.endpointCacheDisabled;
    this.disableMetrics = !!opts.disableMetrics;
    const headers = { ...opts.headers ?? {} };
    if (this.apiKey && !headers["OPEN-SANDBOX-API-KEY"]) {
      headers["OPEN-SANDBOX-API-KEY"] = this.apiKey;
    }
    if (isNodeRuntime3() && this.userAgent && !headers["user-agent"] && !headers["User-Agent"]) {
      headers["user-agent"] = this.userAgent;
    }
    this.headers = headers;
    this._fetch = null;
    this._sseFetch = null;
    this._closeTransport = async () => {
    };
    this._transportInitialized = false;
  }
  get fetch() {
    return this._fetch ?? fetch;
  }
  get sseFetch() {
    return this._sseFetch ?? fetch;
  }
  getBaseUrl() {
    if (this.domain.startsWith("http://") || this.domain.startsWith("https://")) {
      return `${stripV1Suffix(this.domain)}/v1`;
    }
    return `${this.protocol}://${stripV1Suffix(this.domain)}/v1`;
  }
  initializeTransport() {
    if (this._transportInitialized) return;
    const { fetch: baseFetch, close } = createNodeFetch();
    this._fetch = createTimedFetch({
      baseFetch,
      timeoutSeconds: this.requestTimeoutSeconds,
      debug: this.debug,
      defaultHeaders: this.headers,
      label: "http"
    });
    this._sseFetch = createTimedFetch({
      baseFetch,
      timeoutSeconds: 0,
      debug: this.debug,
      defaultHeaders: this.headers,
      label: "sse"
    });
    this._closeTransport = close;
    this._transportInitialized = true;
  }
  /**
   * Ensure this configuration has transport helpers (fetch/SSE) allocated.
   *
   * On Node.js this creates a dedicated `undici` dispatcher; on browsers it
   * simply reuses the global fetch. Returns either `this` or a cloned config
   * with the transport initialized.
   */
  withTransportIfMissing() {
    if (this._transportInitialized) {
      return this;
    }
    const clone = new _ConnectionConfig({
      domain: this.domain,
      protocol: this.protocol,
      apiKey: this.apiKey,
      headers: { ...this.headers },
      requestTimeoutSeconds: this.requestTimeoutSeconds,
      debug: this.debug,
      useServerProxy: this.useServerProxy,
      endpointCacheTtlMs: this.endpointCacheTtlMs,
      endpointCacheSize: this.endpointCacheSize,
      endpointCacheDisabled: this.endpointCacheDisabled,
      disableMetrics: this.disableMetrics
    });
    clone.initializeTransport();
    return clone;
  }
  /**
   * Close the Node.js agent owned by this configuration.
   */
  async closeTransport() {
    if (!this._transportInitialized) return;
    this._closePromise ??= this._closeTransport();
    await this._closePromise;
  }
};
var SandboxManager = class _SandboxManager {
  sandboxes;
  connectionConfig;
  constructor(opts) {
    this.sandboxes = opts.sandboxes;
    this.connectionConfig = opts.connectionConfig;
  }
  static create(opts = {}) {
    const baseConnectionConfig = opts.connectionConfig instanceof ConnectionConfig ? opts.connectionConfig : new ConnectionConfig(opts.connectionConfig);
    const connectionConfig = baseConnectionConfig.withTransportIfMissing();
    const lifecycleBaseUrl = connectionConfig.getBaseUrl();
    const adapterFactory = opts.adapterFactory ?? createDefaultAdapterFactory();
    let sandboxes;
    try {
      sandboxes = adapterFactory.createLifecycleStack({
        connectionConfig,
        lifecycleBaseUrl
      }).sandboxes;
    } catch (err) {
      void connectionConfig.closeTransport().catch(() => void 0);
      throw err;
    }
    return new _SandboxManager({ sandboxes, connectionConfig });
  }
  listSandboxInfos(filter = {}) {
    return this.sandboxes.listSandboxes({
      states: filter.states,
      metadata: filter.metadata,
      page: filter.page,
      pageSize: filter.pageSize
    });
  }
  getSandboxInfo(sandboxId) {
    return this.sandboxes.getSandbox(sandboxId);
  }
  patchSandboxMetadata(sandboxId, patch) {
    return this.sandboxes.patchSandboxMetadata(sandboxId, patch);
  }
  killSandbox(sandboxId) {
    return this.sandboxes.deleteSandbox(sandboxId);
  }
  pauseSandbox(sandboxId) {
    return this.sandboxes.pauseSandbox(sandboxId);
  }
  resumeSandbox(sandboxId) {
    return this.sandboxes.resumeSandbox(sandboxId);
  }
  /**
   * Renew expiration by setting expiresAt to now + timeoutSeconds.
   */
  async renewSandbox(sandboxId, timeoutSeconds) {
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1e3).toISOString();
    await this.sandboxes.renewSandboxExpiration(sandboxId, { expiresAt });
  }
  createSnapshot(sandboxId, req) {
    return this.sandboxes.createSnapshot(sandboxId, req);
  }
  getSnapshot(snapshotId) {
    return this.sandboxes.getSnapshot(snapshotId);
  }
  listSnapshots(filter = {}) {
    return this.sandboxes.listSnapshots(filter);
  }
  deleteSnapshot(snapshotId) {
    return this.sandboxes.deleteSnapshot(snapshotId);
  }
  /**
   * Release the HTTP agent resources allocated for this manager instance.
   *
   * Each manager clone owns a scoped `ConnectionConfig` clone.
   *
   * This mirrors the Python SDK's default transport lifecycle.
   */
  async close() {
    await this.connectionConfig.closeTransport();
  }
};
var DISABLE_METRICS_ENV = "OPENSANDBOX_DISABLE_METRICS";
function readEnv2(name) {
  const env = globalThis?.process?.env;
  const v = env?.[name];
  return typeof v === "string" && v.length ? v : void 0;
}
function envMetricsDisabled() {
  return readEnv2(DISABLE_METRICS_ENV)?.trim() === "1";
}
function metricsDisabled(connectionConfig) {
  return connectionConfig.disableMetrics || envMetricsDisabled();
}
function reportSandboxCreateMetric(connectionConfig, opts) {
  if (metricsDisabled(connectionConfig)) {
    return;
  }
  try {
    const payload = {
      eventType: "sandbox.create",
      createDurationMs: Math.max(0, Math.floor(opts.createDurationMs)),
      success: opts.success
    };
    if (opts.sandboxId) {
      payload.sandboxId = opts.sandboxId;
    }
    if (opts.image) {
      payload.image = opts.image;
    }
    const url = `${connectionConfig.getBaseUrl().replace(/\/$/, "")}/metrics/events`;
    const headers = {
      "Content-Type": "application/json",
      ...connectionConfig.headers ?? {}
    };
    if (connectionConfig.apiKey && !headers["OPEN-SANDBOX-API-KEY"]) {
      headers["OPEN-SANDBOX-API-KEY"] = connectionConfig.apiKey;
    }
    if (!headers["User-Agent"] && !headers["user-agent"]) {
      headers["User-Agent"] = connectionConfig.userAgent || DEFAULT_USER_AGENT;
    }
    void connectionConfig.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }).then(async (res) => {
      try {
        await res.arrayBuffer();
      } catch {
      }
    }).catch(() => {
    });
  } catch {
  }
}
var HOST_PATH_PATTERN = /^([/]|[A-Za-z]:[\\/])/;
var unavailableIsolation = {
  create() {
    throw new Error("Isolation is not available: the adapter factory did not provide an IsolationService");
  },
  attach() {
    throw new Error("Isolation is not available: the adapter factory did not provide an IsolationService");
  },
  capabilities() {
    return Promise.resolve({
      available: false,
      setpriv_available: false,
      userns_available: false,
      commit_supported: false,
      diff_supported: false
    });
  },
  list() {
    throw new Error("Isolation is not available: the adapter factory did not provide an IsolationService");
  },
  runOnce() {
    throw new Error("Isolation is not available: the adapter factory did not provide an IsolationService");
  },
  withSession() {
    throw new Error("Isolation is not available: the adapter factory did not provide an IsolationService");
  }
};
var CREDENTIAL_VAULT_METHODS = [
  "create",
  "get",
  "patch",
  "delete",
  "listCredentials",
  "getCredential",
  "listBindings",
  "getBinding"
];
function isCredentialVault(value) {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const candidate = value;
  return CREDENTIAL_VAULT_METHODS.every(
    (method) => typeof candidate[method] === "function"
  );
}
function unavailableCredentialVault() {
  const fail = async (..._args) => {
    throw new Error(
      "Credential Vault is not available for this adapter factory. Provide EgressStack.credentialVault to use Credential Vault with a custom adapter."
    );
  };
  return {
    create: fail,
    get: fail,
    patch: fail,
    delete: fail,
    listCredentials: fail,
    getCredential: fail,
    listBindings: fail,
    getBinding: fail
  };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function toImageSpec(image) {
  if (typeof image === "string") return { uri: image };
  return { uri: image.uri, auth: image.auth };
}
var Sandbox = class _Sandbox {
  id;
  connectionConfig;
  /**
   * Lifecycle (sandbox management) service.
   */
  sandboxes;
  /**
   * Execd services.
   */
  commands;
  /**
   * High-level filesystem facade (JS-friendly).
   */
  files;
  health;
  metrics;
  isolation;
  /**
   * Sandbox-scoped Credential Vault operations.
   */
  credentialVault;
  /**
   * Internal state kept out of the public instance shape.
   *
   * This avoids nominal typing issues when multiple copies of the SDK exist in a dependency graph.
   */
  static _priv = /* @__PURE__ */ new WeakMap();
  constructor(opts) {
    this.id = opts.id;
    this.connectionConfig = opts.connectionConfig;
    const credentialVault = opts.credentialVault ?? (isCredentialVault(opts.egress) ? opts.egress : unavailableCredentialVault());
    _Sandbox._priv.set(this, {
      adapterFactory: opts.adapterFactory,
      lifecycleBaseUrl: opts.lifecycleBaseUrl,
      execdBaseUrl: opts.execdBaseUrl,
      egress: opts.egress
    });
    this.sandboxes = opts.sandboxes;
    this.commands = opts.commands;
    this.files = opts.files;
    this.health = opts.health;
    this.metrics = opts.metrics;
    this.isolation = opts.isolation;
    this.credentialVault = credentialVault;
  }
  static async create(opts) {
    if (opts.image == null === (opts.snapshotId == null)) {
      throw new Error("Exactly one of image or snapshotId must be provided");
    }
    if (opts.volumes) {
      for (const vol of opts.volumes) {
        const backendsSpecified = [vol.host, vol.pvc, vol.ossfs].filter((b) => b != null).length;
        if (backendsSpecified === 0) {
          throw new Error(
            `Volume '${vol.name}' must specify exactly one backend (host, pvc, ossfs), but none was provided.`
          );
        }
        if (backendsSpecified > 1) {
          throw new Error(
            `Volume '${vol.name}' must specify exactly one backend (host, pvc, ossfs), but multiple were provided.`
          );
        }
        if (vol.host && !HOST_PATH_PATTERN.test(vol.host.path)) {
          throw new Error(
            "Host path must be an absolute path starting with '/' or a Windows drive letter (e.g. 'C:\\' or 'D:/')"
          );
        }
      }
    }
    const baseConnectionConfig = opts.connectionConfig instanceof ConnectionConfig ? opts.connectionConfig : new ConnectionConfig(opts.connectionConfig);
    const connectionConfig = baseConnectionConfig.withTransportIfMissing();
    const lifecycleBaseUrl = connectionConfig.getBaseUrl();
    const adapterFactory = opts.adapterFactory ?? createDefaultAdapterFactory();
    let sandboxes;
    try {
      sandboxes = adapterFactory.createLifecycleStack({
        connectionConfig,
        lifecycleBaseUrl
      }).sandboxes;
    } catch (err) {
      await connectionConfig.closeTransport();
      throw err;
    }
    const rawTimeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const timeoutSeconds = opts.timeoutSeconds === null ? null : Math.floor(rawTimeout);
    if (timeoutSeconds !== null && !Number.isFinite(timeoutSeconds)) {
      throw new Error(
        `timeoutSeconds must be a finite number, got ${opts.timeoutSeconds}`
      );
    }
    const req = {
      image: opts.image == null ? void 0 : toImageSpec(opts.image),
      snapshotId: opts.snapshotId,
      entrypoint: opts.entrypoint ?? DEFAULT_ENTRYPOINT,
      resourceLimits: opts.resource ?? DEFAULT_RESOURCE_LIMITS,
      resourceRequests: opts.resourceRequests,
      secureAccess: opts.secureAccess ?? false,
      env: opts.env ?? {},
      metadata: opts.metadata ?? {},
      networkPolicy: opts.networkPolicy ? {
        ...opts.networkPolicy,
        defaultAction: opts.networkPolicy.defaultAction ?? "deny"
      } : void 0,
      credentialProxy: opts.credentialProxy,
      volumes: opts.volumes,
      extensions: opts.extensions ?? {},
      platform: opts.platform
    };
    if (timeoutSeconds !== null) {
      req.timeout = timeoutSeconds;
    }
    let sandboxId;
    const startupSource = typeof opts.image === "string" ? opts.image : opts.image?.uri ?? opts.snapshotId;
    const createStarted = Date.now();
    try {
      const created = await sandboxes.createSandbox(req);
      sandboxId = created.id;
      const endpoint = await sandboxes.getSandboxEndpoint(
        sandboxId,
        DEFAULT_EXECD_PORT,
        connectionConfig.useServerProxy
      );
      const egressEndpoint = await sandboxes.getSandboxEndpoint(
        sandboxId,
        DEFAULT_EGRESS_PORT,
        connectionConfig.useServerProxy
      );
      const execdBaseUrl = `${connectionConfig.protocol}://${endpoint.endpoint}`;
      const egressBaseUrl = `${connectionConfig.protocol}://${egressEndpoint.endpoint}`;
      const execdStack = adapterFactory.createExecdStack({
        connectionConfig,
        execdBaseUrl,
        endpointHeaders: endpoint.headers
      });
      const { egress, credentialVault } = adapterFactory.createEgressStack({
        connectionConfig,
        egressBaseUrl,
        endpointHeaders: egressEndpoint.headers
      });
      const { commands, files, health, metrics, isolation } = execdStack;
      const sbx = new _Sandbox({
        id: sandboxId,
        connectionConfig,
        adapterFactory,
        lifecycleBaseUrl,
        execdBaseUrl,
        sandboxes,
        commands,
        files,
        health,
        metrics,
        isolation: isolation ?? unavailableIsolation,
        egress,
        credentialVault
      });
      if (!(opts.skipHealthCheck ?? false)) {
        await sbx.waitUntilReady({
          readyTimeoutSeconds: opts.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS,
          pollingIntervalMillis: opts.healthCheckPollingInterval ?? DEFAULT_HEALTH_CHECK_POLLING_INTERVAL_MILLIS,
          healthCheck: opts.healthCheck
        });
      }
      reportSandboxCreateMetric(connectionConfig, {
        sandboxId,
        image: startupSource,
        createDurationMs: Date.now() - createStarted,
        success: true
      });
      return sbx;
    } catch (err) {
      reportSandboxCreateMetric(connectionConfig, {
        sandboxId,
        image: startupSource,
        createDurationMs: Date.now() - createStarted,
        success: false
      });
      if (sandboxId) {
        try {
          await sandboxes.deleteSandbox(sandboxId);
        } catch {
        }
      }
      await connectionConfig.closeTransport();
      throw err;
    }
  }
  static async connect(opts) {
    const baseConnectionConfig = opts.connectionConfig instanceof ConnectionConfig ? opts.connectionConfig : new ConnectionConfig(opts.connectionConfig);
    const connectionConfig = baseConnectionConfig.withTransportIfMissing();
    const adapterFactory = opts.adapterFactory ?? createDefaultAdapterFactory();
    const lifecycleBaseUrl = connectionConfig.getBaseUrl();
    let sandboxes;
    try {
      sandboxes = adapterFactory.createLifecycleStack({
        connectionConfig,
        lifecycleBaseUrl
      }).sandboxes;
    } catch (err) {
      await connectionConfig.closeTransport();
      throw err;
    }
    try {
      const endpoint = await sandboxes.getSandboxEndpoint(
        opts.sandboxId,
        DEFAULT_EXECD_PORT,
        connectionConfig.useServerProxy
      );
      const egressEndpoint = await sandboxes.getSandboxEndpoint(
        opts.sandboxId,
        DEFAULT_EGRESS_PORT,
        connectionConfig.useServerProxy
      );
      const execdBaseUrl = `${connectionConfig.protocol}://${endpoint.endpoint}`;
      const egressBaseUrl = `${connectionConfig.protocol}://${egressEndpoint.endpoint}`;
      const execdStack = adapterFactory.createExecdStack({
        connectionConfig,
        execdBaseUrl,
        endpointHeaders: endpoint.headers
      });
      const { egress, credentialVault } = adapterFactory.createEgressStack({
        connectionConfig,
        egressBaseUrl,
        endpointHeaders: egressEndpoint.headers
      });
      const { commands, files, health, metrics, isolation } = execdStack;
      const sbx = new _Sandbox({
        id: opts.sandboxId,
        connectionConfig,
        adapterFactory,
        lifecycleBaseUrl,
        execdBaseUrl,
        sandboxes,
        commands,
        files,
        health,
        metrics,
        isolation: isolation ?? unavailableIsolation,
        egress,
        credentialVault
      });
      if (!(opts.skipHealthCheck ?? false)) {
        await sbx.waitUntilReady({
          readyTimeoutSeconds: opts.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS,
          pollingIntervalMillis: opts.healthCheckPollingInterval ?? DEFAULT_HEALTH_CHECK_POLLING_INTERVAL_MILLIS,
          healthCheck: opts.healthCheck
        });
      }
      return sbx;
    } catch (err) {
      await connectionConfig.closeTransport();
      throw err;
    }
  }
  async getInfo() {
    return await this.sandboxes.getSandbox(this.id);
  }
  async isHealthy() {
    try {
      return await this.health.ping();
    } catch {
      return false;
    }
  }
  async getMetrics() {
    return await this.metrics.getMetrics();
  }
  async pause() {
    this.sandboxes.invalidateEndpointCache?.(this.id);
    await this.sandboxes.pauseSandbox(this.id);
  }
  /**
   * Resume a paused sandbox and return a fresh, connected Sandbox instance.
   *
   * After resume, the execd endpoint may change, so this method returns a new
   * {@link Sandbox} instance with a refreshed execd base URL.
   */
  async resume(opts = {}) {
    await this.sandboxes.resumeSandbox(this.id);
    return await _Sandbox.connect({
      sandboxId: this.id,
      connectionConfig: this.connectionConfig,
      adapterFactory: _Sandbox._priv.get(this).adapterFactory,
      skipHealthCheck: opts.skipHealthCheck ?? false,
      readyTimeoutSeconds: opts.readyTimeoutSeconds,
      healthCheckPollingInterval: opts.healthCheckPollingInterval
    });
  }
  /**
   * Resume a paused sandbox by id, then connect to its execd endpoint.
   */
  static async resume(opts) {
    const baseConnectionConfig = opts.connectionConfig instanceof ConnectionConfig ? opts.connectionConfig : new ConnectionConfig(opts.connectionConfig);
    const adapterFactory = opts.adapterFactory ?? createDefaultAdapterFactory();
    const resumeConnectionConfig = baseConnectionConfig.withTransportIfMissing();
    const lifecycleBaseUrl = resumeConnectionConfig.getBaseUrl();
    let sandboxes;
    try {
      sandboxes = adapterFactory.createLifecycleStack({
        connectionConfig: resumeConnectionConfig,
        lifecycleBaseUrl
      }).sandboxes;
      await sandboxes.resumeSandbox(opts.sandboxId);
    } catch (err) {
      await resumeConnectionConfig.closeTransport();
      throw err;
    }
    await resumeConnectionConfig.closeTransport();
    return await _Sandbox.connect({ ...opts, connectionConfig: baseConnectionConfig, adapterFactory });
  }
  async kill() {
    this.sandboxes.invalidateEndpointCache?.(this.id);
    await this.sandboxes.deleteSandbox(this.id);
  }
  /**
   * Release any client-side resources (e.g. Node.js HTTP agents) owned by this Sandbox instance.
   */
  async close() {
    await this.connectionConfig.closeTransport();
  }
  /**
   * Renew expiration by setting expiresAt to now + timeoutSeconds.
   */
  async renew(timeoutSeconds) {
    const expiresAt = new Date(
      Date.now() + timeoutSeconds * 1e3
    ).toISOString();
    return await this.sandboxes.renewSandboxExpiration(this.id, { expiresAt });
  }
  async patchMetadata(patch) {
    return await this.sandboxes.patchSandboxMetadata(this.id, patch);
  }
  async getEgressPolicy() {
    return await _Sandbox._priv.get(this).egress.getPolicy();
  }
  async patchEgressRules(rules) {
    await _Sandbox._priv.get(this).egress.patchRules(rules);
  }
  async deleteEgressRules(targets) {
    await _Sandbox._priv.get(this).egress.deleteRules(targets);
  }
  /**
   * Get sandbox endpoint for a port (STRICT: no scheme), e.g. "localhost:44772" or "domain/route/.../44772".
   */
  async getEndpoint(port) {
    return await this.sandboxes.getSandboxEndpoint(
      this.id,
      port,
      this.connectionConfig.useServerProxy
    );
  }
  /**
   * Get signed endpoint URL with an OSEP-0011 route token that expires at the given Unix epoch timestamp (seconds).
   */
  async getSignedEndpoint(port, expires) {
    return await this.sandboxes.getSignedEndpoint(this.id, port, expires);
  }
  /**
   * Get absolute endpoint URL with scheme (convenience for HTTP clients).
   */
  async getEndpointUrl(port) {
    const ep = await this.getEndpoint(port);
    return `${this.connectionConfig.protocol}://${ep.endpoint}`;
  }
  async waitUntilReady(opts) {
    const deadline = Date.now() + opts.readyTimeoutSeconds * 1e3;
    let attempt = 0;
    let errorDetail = "Health check returned false continuously.";
    const buildTimeoutMessage = () => {
      const context = `domain=${this.connectionConfig.domain}, useServerProxy=${this.connectionConfig.useServerProxy}`;
      let suggestion = "If this sandbox runs in Docker bridge or remote-network mode, consider enabling useServerProxy=true.";
      if (!this.connectionConfig.useServerProxy) {
        suggestion += " You can also configure server-side [docker].host_ip for direct endpoint access.";
      }
      return `Sandbox health check timed out after ${opts.readyTimeoutSeconds}s (${attempt} attempts). ${errorDetail} Connection context: ${context}. ${suggestion}`;
    };
    while (true) {
      if (Date.now() > deadline) {
        throw new SandboxReadyTimeoutException({
          message: buildTimeoutMessage()
        });
      }
      attempt++;
      try {
        if (opts.healthCheck) {
          const ok = await opts.healthCheck(this);
          if (ok) {
            return;
          }
        } else {
          const ok = await this.health.ping();
          if (ok) {
            return;
          }
        }
        errorDetail = "Health check returned false continuously.";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorDetail = `Last health check error: ${message}`;
      }
      await sleep(opts.pollingIntervalMillis);
    }
  }
};

// src/client.ts
var SandboxClientImpl = class {
  config;
  connection;
  registry = /* @__PURE__ */ new Map();
  managerInstance = null;
  constructor(config) {
    this.config = config;
    this.connection = new ConnectionConfig({
      domain: config.domain,
      protocol: config.protocol,
      apiKey: config.apiKey,
      requestTimeoutSeconds: config.requestTimeoutSeconds,
      useServerProxy: config.useServerProxy
    });
  }
  async create(options) {
    const sandbox = await Sandbox.create({
      connectionConfig: this.connection,
      ...options
    });
    this.register(sandbox);
    return sandbox;
  }
  async getSandbox(sandboxId) {
    const hit = this.registry.get(sandboxId);
    if (hit) {
      this.registry.delete(sandboxId);
      this.registry.set(sandboxId, hit);
      return hit;
    }
    const sandbox = await Sandbox.connect({
      sandboxId,
      connectionConfig: this.connection
    });
    this.register(sandbox);
    return sandbox;
  }
  register(sandbox) {
    const existing = this.registry.get(sandbox.id);
    if (existing && existing !== sandbox) {
      void existing.close().catch(() => void 0);
    }
    this.registry.delete(sandbox.id);
    this.registry.set(sandbox.id, sandbox);
    this.evict();
  }
  async release(sandboxId) {
    const sandbox = this.registry.get(sandboxId);
    this.registry.delete(sandboxId);
    if (sandbox) {
      await sandbox.close().catch(() => void 0);
    }
  }
  manager() {
    this.managerInstance ??= SandboxManager.create({
      connectionConfig: this.connection
    });
    return this.managerInstance;
  }
  evict() {
    while (this.registry.size > this.config.sandboxCacheSize) {
      const oldestId = this.registry.keys().next().value;
      if (oldestId == null) break;
      const oldest = this.registry.get(oldestId);
      this.registry.delete(oldestId);
      if (oldest) {
        void oldest.close().catch(() => void 0);
      }
    }
  }
};
var clientCache = /* @__PURE__ */ new Map();
function getSandboxClient(config) {
  const key = [
    config.domain,
    config.protocol,
    config.apiKey ?? "",
    config.useServerProxy,
    config.requestTimeoutSeconds
  ].join("|");
  let client = clientCache.get(key);
  if (!client) {
    client = new SandboxClientImpl(config);
    clientCache.set(key, client);
  }
  return client;
}

// src/errors.ts
function toReadableError(err) {
  if (err instanceof SandboxException) {
    const code = err.error?.code ?? "SANDBOX_ERROR";
    const status = err instanceof SandboxApiException && err.statusCode != null ? ` (status=${err.statusCode})` : "";
    const requestId = err.requestId ? ` [requestId=${err.requestId}]` : "";
    const detail = err.message ? `: ${err.message}` : "";
    return new Error(`OpenSandbox ${err.name} [${code}]${status}${requestId}${detail}`);
  }
  if (err instanceof Error) {
    return err;
  }
  return new Error(`OpenSandbox error: ${String(err)}`);
}
async function withErrorHandling(fn) {
  try {
    return await fn();
  } catch (err) {
    throw toReadableError(err);
  }
}

// src/tools/lifecycle.ts
var networkRuleSchema = typebox_exports.Object(
  {
    action: typebox_exports.Union([typebox_exports.Literal("allow"), typebox_exports.Literal("deny")], {
      description: "Whether to allow or deny matching targets."
    }),
    target: typebox_exports.String({
      description: 'FQDN or wildcard domain, e.g. "example.com" or "*.example.com". IP/CIDR targets are not supported.'
    })
  },
  { additionalProperties: false }
);
var networkPolicySchema = typebox_exports.Object(
  {
    defaultAction: typebox_exports.Optional(
      typebox_exports.Union([typebox_exports.Literal("allow"), typebox_exports.Literal("deny")], {
        description: "Default action when no egress rule matches (server default: deny)."
      })
    ),
    egress: typebox_exports.Optional(
      typebox_exports.Array(networkRuleSchema, {
        description: "Outbound egress rules, evaluated in order."
      })
    )
  },
  { additionalProperties: false }
);
var createSandboxParams = typebox_exports.Object({
  image: typebox_exports.Optional(
    typebox_exports.String({
      description: "Container image, e.g. python:3.11. Defaults to the plugin defaultImage config."
    })
  ),
  timeoutSeconds: typebox_exports.Optional(
    typebox_exports.Number({
      description: "Server-side TTL in seconds; the sandbox and all its data are destroyed when it expires."
    })
  ),
  env: typebox_exports.Optional(
    typebox_exports.Record(typebox_exports.String(), typebox_exports.String(), {
      description: "Environment variables injected into the sandbox."
    })
  ),
  metadata: typebox_exports.Optional(
    typebox_exports.Record(typebox_exports.String(), typebox_exports.String(), {
      description: "Custom metadata tags for filtering/management."
    })
  ),
  resource: typebox_exports.Optional(
    typebox_exports.Record(typebox_exports.String(), typebox_exports.String(), {
      description: "Resource limits for the container, e.g. {cpu: '1', memory: '2Gi'}."
    })
  ),
  networkPolicy: typebox_exports.Optional(networkPolicySchema),
  entrypoint: typebox_exports.Optional(
    typebox_exports.Array(typebox_exports.String(), {
      description: "Entrypoint command; defaults to tail -f /dev/null."
    })
  )
});
var connectSandboxParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({
    description: "ID of an existing sandbox, e.g. from a previous sandbox_create call or from another process."
  })
});
var listSandboxesParams = typebox_exports.Object({
  states: typebox_exports.Optional(
    typebox_exports.Array(typebox_exports.String(), {
      description: "Filter by lifecycle state, e.g. ['Running', 'Paused']."
    })
  ),
  metadata: typebox_exports.Optional(
    typebox_exports.Record(typebox_exports.String(), typebox_exports.String(), {
      description: "Filter by exact metadata key-value pairs."
    })
  ),
  page: typebox_exports.Optional(
    typebox_exports.Number({ description: "Pagination page (1-indexed)." })
  ),
  pageSize: typebox_exports.Optional(
    typebox_exports.Number({ description: "Items per page." })
  )
});
var getSandboxInfoParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Target sandbox ID." })
});
var renewSandboxParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Target sandbox ID." }),
  timeoutSeconds: typebox_exports.Number({
    description: "New TTL in seconds from now; the sandbox expires timeoutSeconds later."
  })
});
var killSandboxParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Target sandbox ID." })
});
var getEndpointParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Target sandbox ID." }),
  port: typebox_exports.Number({
    description: "Port inside the sandbox to expose, e.g. 8080."
  })
});
async function execCreateSandbox(client, _config, params) {
  const sandbox = await client.create({
    image: params.image ?? client.config.defaultImage,
    timeoutSeconds: params.timeoutSeconds,
    env: params.env,
    metadata: params.metadata,
    resource: params.resource,
    networkPolicy: params.networkPolicy,
    entrypoint: params.entrypoint
  });
  const info = await sandbox.getInfo();
  return {
    sandboxId: sandbox.id,
    state: info.status.state,
    createdAt: info.createdAt.toISOString(),
    expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null
  };
}
async function execConnectSandbox(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.getInfo();
  return { sandboxId: sandbox.id, state: info.status.state };
}
async function execListSandboxes(client, _config, params) {
  const res = await client.manager().listSandboxInfos({
    states: params.states,
    metadata: params.metadata,
    page: params.page,
    pageSize: params.pageSize
  });
  return {
    items: res.items.map((i) => ({
      id: i.id,
      state: i.status.state,
      createdAt: i.createdAt.toISOString()
    })),
    page: res.pagination?.page ?? 1,
    total: res.pagination?.totalItems ?? res.items.length
  };
}
async function execGetSandboxInfo(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.getInfo();
  return {
    sandboxId: info.id,
    state: info.status.state,
    statusReason: info.status.reason ?? null,
    statusMessage: info.status.message ?? null,
    createdAt: info.createdAt.toISOString(),
    expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
    metadata: info.metadata ?? {},
    image: info.image?.uri ?? null,
    entrypoint: info.entrypoint
  };
}
async function execRenewSandbox(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const res = await sandbox.renew(params.timeoutSeconds);
  return {
    sandboxId: params.sandboxId,
    expiresAt: res.expiresAt ? res.expiresAt.toISOString() : null
  };
}
async function execKillSandbox(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.kill();
  await client.release(params.sandboxId);
  return { sandboxId: params.sandboxId, state: "terminated" };
}
async function execGetEndpoint(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const endpoint = await sandbox.getEndpointUrl(params.port);
  return { endpoint };
}

// src/truncate.ts
var encoder2 = new TextEncoder();
var decoder = new TextDecoder("utf-8");
function truncateText(text, maxBytes) {
  if (maxBytes <= 0) {
    return { content: "", truncated: text.length > 0 };
  }
  const bytes = encoder2.encode(text);
  if (bytes.length <= maxBytes) {
    return { content: text, truncated: false };
  }
  const cut = decoder.decode(bytes.subarray(0, maxBytes));
  return {
    content: `${cut}
\u2026 [output truncated: ${bytes.length - maxBytes} bytes omitted]`,
    truncated: true
  };
}

// src/tools/command.ts
var runCommandParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({
    description: "Sandbox ID from sandbox_create or sandbox_connect."
  }),
  command: typebox_exports.String({
    description: "Shell command to run inside the sandbox."
  }),
  workingDirectory: typebox_exports.Optional(
    typebox_exports.String({ description: "Working directory for the command." })
  ),
  timeoutSeconds: typebox_exports.Optional(
    typebox_exports.Number({
      description: "Maximum execution time in seconds; the server terminates the command when reached."
    })
  )
});
var interruptCommandParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Sandbox ID." }),
  executionId: typebox_exports.String({
    description: "Execution ID returned by sandbox_run_command."
  })
});
async function execRunCommand(client, config, params, signal) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const execution = await sandbox.commands.run(
    params.command,
    {
      workingDirectory: params.workingDirectory,
      timeoutSeconds: params.timeoutSeconds
    },
    void 0,
    signal
  );
  const stdout = execution.logs.stdout.map((m) => m.text).join("");
  const stderr = execution.logs.stderr.map((m) => m.text).join("");
  const out = truncateText(stdout, config.maxOutputBytes);
  const err = truncateText(stderr, config.maxOutputBytes);
  return {
    sandboxId: params.sandboxId,
    executionId: execution.id ?? null,
    exitCode: execution.exitCode ?? null,
    stdout: out.content,
    stderr: err.content,
    executionTimeMs: execution.complete?.executionTimeMs ?? null,
    truncated: out.truncated || err.truncated
  };
}
async function execInterruptCommand(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.commands.interrupt(params.executionId);
  return { interrupted: true, executionId: params.executionId };
}

// src/tools/files.ts
var readFileParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Sandbox ID." }),
  path: typebox_exports.String({ description: "Absolute path of the file to read." }),
  encoding: typebox_exports.Optional(
    typebox_exports.String({ description: "Text encoding, e.g. utf-8 (default)." })
  ),
  rangeHeader: typebox_exports.Optional(
    typebox_exports.String({
      description: "HTTP Range header for partial reads, e.g. bytes=0-1023."
    })
  )
});
var writeFileParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Sandbox ID." }),
  path: typebox_exports.String({ description: "Absolute path of the file to write." }),
  content: typebox_exports.String({ description: "Text content to write." }),
  mode: typebox_exports.Optional(
    typebox_exports.Number({ description: "POSIX permission bits, e.g. 0o644." })
  )
});
var listFilesParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Sandbox ID." }),
  path: typebox_exports.String({ description: "Directory to list." }),
  depth: typebox_exports.Optional(
    typebox_exports.Number({ description: "Maximum recursion depth." })
  )
});
var deleteFilesParams = typebox_exports.Object({
  sandboxId: typebox_exports.String({ description: "Sandbox ID." }),
  paths: typebox_exports.Array(typebox_exports.String(), {
    description: "Files and/or directories to delete."
  }),
  recursive: typebox_exports.Optional(
    typebox_exports.Boolean({
      description: "Allow deleting directories. Directories are always removed recursively; without this, directory paths are rejected."
    })
  )
});
async function execReadFile(client, config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const content = await sandbox.files.readFile(params.path, {
    encoding: params.encoding,
    range: params.rangeHeader
  });
  const out = truncateText(content, config.maxOutputBytes);
  return { path: params.path, content: out.content, truncated: out.truncated };
}
async function execWriteFile(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.files.writeFiles([
    { path: params.path, data: params.content, mode: params.mode }
  ]);
  const bytes = new TextEncoder().encode(params.content).length;
  return { path: params.path, size: bytes };
}
async function execListFiles(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const entries = await sandbox.files.listDirectory({
    path: params.path,
    depth: params.depth
  });
  return {
    items: entries.map((f) => ({
      path: f.path,
      type: f.type ?? "file",
      size: f.size ?? 0,
      mode: f.mode ?? null
    }))
  };
}
async function execDeleteFiles(client, _config, params) {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.files.getFileInfo(params.paths);
  const directories = [];
  const files = [];
  for (const p of params.paths) {
    if (info[p]?.type === "directory") {
      directories.push(p);
    } else {
      files.push(p);
    }
  }
  if (directories.length > 0 && !params.recursive) {
    throw new Error(
      `Refusing to delete directories [${directories.join(", ")}] without recursive=true`
    );
  }
  if (directories.length > 0) {
    await sandbox.files.deleteDirectories(directories);
  }
  if (files.length > 0) {
    await sandbox.files.deleteFiles(files);
  }
  return { deleted: params.paths };
}

// src/index.ts
function executeWith(fn) {
  return (params, config, context) => {
    context.signal?.throwIfAborted();
    const pluginConfig = normalizeConfig(config);
    return withErrorHandling(
      () => fn(getSandboxClient(pluginConfig), pluginConfig, params, context.signal)
    );
  };
}
var index_default = defineToolPlugin({
  id: "opensandbox-openclaw",
  name: "OpenSandbox Sandbox",
  description: "Create and manage OpenSandbox sandboxes: lifecycle management, shell command execution, and file operations. Use sandbox_create or sandbox_connect to obtain a sandbox_id, keep track of it, and pass it to every subsequent tool call.",
  configSchema,
  tools: (tool) => [
    // ------------------------------------------------------------------ lifecycle
    tool({
      name: "sandbox_create",
      label: "Create Sandbox",
      description: "Create a new OpenSandbox sandbox and return its sandbox_id. Remember the returned sandbox_id and pass it to all subsequent tools. The sandbox expires after timeoutSeconds (server-side TTL); renew it with sandbox_renew if you need it longer. Sandboxes are stateless: killing or TTL expiry destroys all data inside.",
      parameters: createSandboxParams,
      execute: executeWith(execCreateSandbox)
    }),
    tool({
      name: "sandbox_connect",
      label: "Connect Sandbox",
      description: "Connect to an existing sandbox by ID (e.g. after a plugin/process restart, or a sandbox created by another client). Returns the current state of the sandbox.",
      parameters: connectSandboxParams,
      execute: executeWith(execConnectSandbox)
    }),
    tool({
      name: "sandbox_list",
      label: "List Sandboxes",
      description: "List sandboxes with optional state/metadata filters and pagination. Returns id, state, and createdAt for each sandbox.",
      parameters: listSandboxesParams,
      execute: executeWith(execListSandboxes)
    }),
    tool({
      name: "sandbox_get_info",
      label: "Get Sandbox Info",
      description: "Get status and metadata of a sandbox, including expiresAt. Check expiresAt to know when the sandbox will be destroyed by the server-side TTL, and renew with sandbox_renew if needed.",
      parameters: getSandboxInfoParams,
      execute: executeWith(execGetSandboxInfo)
    }),
    tool({
      name: "sandbox_renew",
      label: "Renew Sandbox",
      description: "Extend a sandbox's lifetime by setting a new expiration timeoutSeconds from now. Returns the new expiresAt.",
      parameters: renewSandboxParams,
      execute: executeWith(execRenewSandbox)
    }),
    tool({
      name: "sandbox_kill",
      label: "Kill Sandbox",
      description: "Terminates the sandbox and permanently destroys all data inside it. Sandboxes are stateless: kill or TTL expiry destroys all data. BEFORE calling this tool you MUST export any files or final artifacts you need, e.g. read small files with sandbox_read_file, package directories with sandbox_run_command (tar + base64), or download via the endpoint from sandbox_get_endpoint. Once killed, the data is gone.",
      parameters: killSandboxParams,
      execute: executeWith(execKillSandbox)
    }),
    tool({
      name: "sandbox_get_endpoint",
      label: "Get Sandbox Endpoint",
      description: "Get an absolute URL for a port inside the sandbox (e.g. a web server the agent started). The endpoint is reachable from the plugin host; when useServerProxy is enabled (default) traffic is routed through the lifecycle server.",
      parameters: getEndpointParams,
      execute: executeWith(execGetEndpoint)
    }),
    // ------------------------------------------------------------------ command
    tool({
      name: "sandbox_run_command",
      label: "Run Command",
      description: "Run a shell command in the sandbox in the foreground and collect its output. Non-zero exit codes are returned normally (not as errors); inspect exitCode and stderr. Output is truncated at the plugin maxOutputBytes config. For artifact-producing commands, export the results before the sandbox is killed or expires. Use the returned executionId with sandbox_interrupt_command to interrupt long-running commands.",
      parameters: runCommandParams,
      execute: executeWith(execRunCommand)
    }),
    tool({
      name: "sandbox_interrupt_command",
      label: "Interrupt Command",
      description: "Interrupt a running command in the sandbox by its executionId (returned by sandbox_run_command).",
      parameters: interruptCommandParams,
      execute: executeWith(execInterruptCommand)
    }),
    // ------------------------------------------------------------------ files
    tool({
      name: "sandbox_read_file",
      label: "Read File",
      description: "Read a text file from the sandbox. Content is truncated at the plugin maxOutputBytes config; use rangeHeader to read large files in chunks. For binary files, use sandbox_run_command (e.g. base64) instead.",
      parameters: readFileParams,
      execute: executeWith(execReadFile)
    }),
    tool({
      name: "sandbox_write_file",
      label: "Write File",
      description: "Write text content to a file in the sandbox, creating intermediate directories as needed. Returns the path and byte size written.",
      parameters: writeFileParams,
      execute: executeWith(execWriteFile)
    }),
    tool({
      name: "sandbox_list_files",
      label: "List Files",
      description: "List entries of a directory in the sandbox with type, size, and mode. Use depth for recursive listing.",
      parameters: listFilesParams,
      execute: executeWith(execListFiles)
    }),
    tool({
      name: "sandbox_delete_files",
      label: "Delete Files",
      description: "Delete files and/or directories in the sandbox. Directories are only removed when recursive is true (always recursively). Note: deletion is permanent and does not honor the stateless-export warning of sandbox_kill; export anything you need first.",
      parameters: deleteFilesParams,
      execute: executeWith(execDeleteFiles)
    })
  ]
});
export {
  index_default as default
};
