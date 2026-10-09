'use strict';
const failure = () => Object.assign(new Error(), { statusCode: 400 });
const variables = ['visitante', 'operador', 'area'];
function integer(value) { if (!Number.isInteger(value) || value < 1 || value > 4294967295) throw failure(); return value; }
function normalizeReply(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw failure();
  const fields = ['departmentId','title','text','active','version','clientKey'];
  if (Object.keys(input).some(key => !fields.includes(key)) ||
    ['departmentId','title','text','active'].some(key => !Object.hasOwn(input,key)) ||
    typeof input.active !== 'boolean' || (input.departmentId !== null && !Number.isInteger(input.departmentId))) throw failure();
  const departmentId = input.departmentId === null ? null : integer(input.departmentId);
  const normalize = (value, maximum, multiline = false) => {
    if (typeof value !== 'string' || value.length > maximum ||
      (multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u : /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u).test(value)) throw failure();
    const text = value.normalize('NFC').trim();
    if (!text || text.length > maximum) throw failure(); return text;
  };
  const title = normalize(input.title,100), text = normalize(input.text,2000,true);
  // Braces have one explicit grammar, with no expressions or recursive expansion.
  const stripped = text.replace(/\{\{(visitante|operador|area)\}\}/g,'');
  if (stripped.includes('{{') || stripped.includes('}}')) throw failure();
  return {departmentId,title,text,active:input.active};
}
module.exports = {normalizeReply,integer,variables};
