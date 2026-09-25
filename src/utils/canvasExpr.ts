/**
 * @file canvasExpr.ts
 * @description 画布单指标常量四则运算解析器（spec §4.7）：字符白名单 → tokenize →
 *              递归下降 AST → 求值。严禁 eval/new Function（安全护栏）；
 *              非法字符/语法直接抛错，由调用方转「表达式无效」提示。可单测全覆盖。
 * @layer Utils (Pure)
 * @storage_impact 无。
 * @author 开发团队
 */

/** 文法（标准四则运算优先级）：
 *  expr   := term (('+'|'-') term)*
 *  term   := factor (('*'|'/') factor)*
 *  factor := NUMBER | '(' expr ')' | ('-'|'+') factor
 */

/** 词法分析：数字（含小数）与运算符/括号；其余字符直接抛错 */
function tokenize(input: string): (number | string)[] {
  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < input.length && ((input[j] >= '0' && input[j] <= '9') || input[j] === '.')) j++;
      const num = Number(input.slice(i, j));
      if (!Number.isFinite(num)) throw new Error('非法数字');
      tokens.push(num);
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    throw new Error(`非法字符: ${ch}`);
  }
  return tokens;
}

/** 递归下降解析器：求值并暴露最终游标（用于「多余字符」校验） */
function createParser(tokens: (number | string)[]) {
  let pos = 0;

  const peek = (): number | string | undefined => tokens[pos];
  const next = (): number | string | undefined => tokens[pos++];

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      if (op === '/' && rhs === 0) throw new Error('除零');
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseFactor(): number {
    const token = next();
    if (typeof token === 'number') return token;
    if (token === '(') {
      const value = parseExpr();
      if (next() !== ')') throw new Error('括号不匹配');
      return value;
    }
    if (token === '-' || token === '+') {
      const value = parseFactor();
      return token === '-' ? -value : value;
    }
    throw new Error('表达式无效');
  }

  return {
    /** 求值完整表达式（必须消费到末尾，否则视为语法错误） */
    evaluate: (): number => {
      const value = parseExpr();
      if (pos < tokens.length) throw new Error('存在未消费的多余字符');
      return value;
    },
  };
}

/**
 * 求值常量四则运算表达式。
 * @param {string} expr - 用户输入表达式（如 "(12.5+3)*2"）
 * @returns {number} 结果（非有限值视为无效）
 * @throws {Error} 非法字符/语法错误/除零（message 用户可读）
 */
export function evalCanvasExpr(expr: string): number {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('表达式为空');
  const tokens = tokenize(trimmed);
  if (!tokens.length) throw new Error('表达式为空');
  const value = createParser(tokens).evaluate();
  if (!Number.isFinite(value)) throw new Error('结果非有限数');
  return value;
}
