// Pack-owned variable logic. Only JSON data is supplied by the host.
// References: Tavern Helper scoped variables and MVU initialization/update ideas;
// this is an independent minimal implementation, not their compatibility layer.
globalThis.packScript = (() => {
  const initial = { public: { 剧情: { 阶段: '初见' } }, private: {} };
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function validate(value, template = initial, path = '') {
    if (template !== null && typeof template === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join('\0') !== Object.keys(template).sort().join('\0')) {
        throw new TypeError('变量结构不匹配：' + path);
      }
      for (const key of Object.keys(template)) {
        if (forbidden.has(key)) throw new TypeError('不允许的变量键');
        validate(value[key], template[key], path + '/' + key);
      }
    } else if (typeof value !== typeof template
        || typeof value === 'number' && !Number.isFinite(value)
        || typeof value === 'string' && value.length > 2000) {
      throw new TypeError('变量值类型或长度不匹配：' + path);
    }
    return clone(value);
  }
  function applyPatch(data, operations) {
    const next = validate(data);
    if (!Array.isArray(operations) || operations.length > 32) throw new TypeError('最多 32 条更新');
    for (const operation of operations) {
      if (!operation || !['replace', 'test'].includes(operation.op)
          || Object.keys(operation).sort().join(',') !== 'op,path,value'
          || typeof operation.path !== 'string' || !operation.path.startsWith('/')) {
        throw new TypeError('只接受 replace/test 的明确路径和值');
      }
      const parts = operation.path.slice(1).split('/').map(part => {
        if (/~(?![01])/u.test(part)) throw new TypeError('无效的 JSON Pointer');
        return part.replace(/~1/gu, '/').replace(/~0/gu, '~');
      });
      if (parts.length < 2 || !['public', 'private'].includes(parts[0]) || parts.some(p => !p || forbidden.has(p))) {
        throw new TypeError('只能更新已声明的公开或本人私有变量');
      }
      let parent = next;
      for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(parent, part) || !parent[part] || typeof parent[part] !== 'object') {
          throw new TypeError('变量路径不存在');
        }
        parent = parent[part];
      }
      const key = parts.at(-1);
      if (!Object.hasOwn(parent, key)) throw new TypeError('变量路径不存在');
      if (operation.op === 'test') {
        if (JSON.stringify(parent[key]) !== JSON.stringify(operation.value)) throw new TypeError('旧变量值不匹配');
      } else {
        parent[key] = clone(operation.value);
      }
    }
    return validate(next); // Validate the whole batch before the host saves anything.
  }
  return { initialize: () => clone(initial), getVariables: data => validate(data), applyPatch };
})();
