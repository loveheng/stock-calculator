/**
 * @file copilotStream.test.ts
 * @description copilotService 流式提问（V3 SSE）单测：事件块解析（delta/done/error/心跳注释）、
 *              consumeAskStream 闭环（增量回调 + 权威 done + 缺 done 报错）、
 *              旧后端 JSON 信封内容协商回落（不回调 onDelta）、请求头协商（Accept/Bearer）、
 *              外部取消句柄（signal abort → CANCELLED，覆盖流中/请求前/信封回落三条路径）。
 * @layer 测试
 * @author 开发团队
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../services/authSession', () => ({
  loadStoredAuthSession: () => ({ token: 'tok-1' }),
}));

import { streamQuestion, parseSseBlock, CopilotApiError } from '../services/copilotService';
import type { CopilotAskRequest } from '../types/domain';

const REQ: CopilotAskRequest = {
  question: 'q',
  sessionTitle: 't',
  clientMessageId: 'cmid-1',
  contextSummary: '{}',
  contextOverview: '{}',
  timeAnchor: '{}',
};

/** 构造 text/event-stream 响应（按块顺序入队，块边界不必对齐事件边界） */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** 旧后端：application/json 恒 200 信封 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ASK_OK = {
  assistantMessageId: 501,
  content: '完整全文',
  promptTokens: 1,
  completionTokens: 2,
  channel: 'deepseek',
  userMessageId: 1,
  ctime: 1_700_000_001,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSseBlock（SSE 事件块解析）', () => {
  it('event + data 行解析；data 多行合并；心跳注释与空行忽略', () => {
    expect(parseSseBlock('event: delta\ndata: {"text":"你好"}')).toEqual({
      event: 'delta',
      data: '{"text":"你好"}',
    });
    expect(parseSseBlock('event: done\ndata: line1\ndata: line2')).toEqual({
      event: 'done',
      data: 'line1\nline2',
    });
    expect(parseSseBlock(': ping\n\n')).toBeNull();
    expect(parseSseBlock('')).toBeNull();
    expect(parseSseBlock('data: only-data')).toEqual({ event: 'message', data: 'only-data' });
  });
});

describe('streamQuestion（SSE 内容协商）', () => {
  it('event-stream：delta 逐段回调，done 返回权威应答；携带 Accept/Bearer 头', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(
      sseResponse([
        ': ping\r\n\r\n', // 心跳注释（\r\n 分隔）
        'event: delta\ndata: {"text":"你"}\n\nevent: delta\ndata: {"text":"好"}\n\n',
        'event: done\ndata: ' + JSON.stringify(ASK_OK) + '\n\n',
      ]),
    );
    const deltas: string[] = [];
    const resp = await streamQuestion('statistics', REQ, (t) => deltas.push(t));
    expect(deltas).toEqual(['你', '好']);
    expect(resp).toEqual(ASK_OK);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/threads/statistics/messages');
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('跨块截断的事件帧正确重组（delta 一半在前块一半在后块）', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: del',
        'ta\ndata: {"text":"截断"}\n\nevent: done\ndata: ' + JSON.stringify(ASK_OK) + '\n\n',
      ]),
    );
    const deltas: string[] = [];
    const resp = await streamQuestion('statistics', REQ, (t) => deltas.push(t));
    expect(deltas).toEqual(['截断']);
    expect(resp.content).toBe('完整全文');
  });

  it('旧后端 JSON 信封回落：解析 data 返回，不回调 onDelta', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: 'ok', data: ASK_OK }));
    const deltas: string[] = [];
    const resp = await streamQuestion('statistics', REQ, (t) => deltas.push(t));
    expect(deltas).toEqual([]);
    expect(resp).toEqual(ASK_OK);
  });

  it('旧后端信封错误：subCode 规范化抛 CopilotApiError', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 429, subCode: 'RATE_LIMIT_EXCEEDED', message: '限流', data: null }),
    );
    await expect(streamQuestion('statistics', REQ, () => {})).rejects.toBeInstanceOf(CopilotApiError);
  });

  it('流中 error 事件：映射 subCode 抛规范化异常', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: delta\ndata: {"text":"半"}\n\n',
        'event: error\ndata: {"code":503,"subCode":"UPSTREAM_ERROR","message":"上游断流"}\n\n',
      ]),
    );
    const deltas: string[] = [];
    await expect(streamQuestion('s', REQ, (t) => deltas.push(t))).rejects.toMatchObject({
      subCode: 'UPSTREAM_ERROR',
      hint: 'AI 服务暂不可用，请稍后重试',
    });
    expect(deltas).toEqual(['半']);
  });

  it('流异常中断（无 done 事件）：报错而非静默返回空', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue(sseResponse(['event: delta\ndata: {"text":"孤儿块"}\n\n']));
    const deltas: string[] = [];
    await expect(streamQuestion('s', REQ, (t) => deltas.push(t))).rejects.toThrow('异常中断');
    expect(deltas).toEqual(['孤儿块']);
  });
});

describe('streamQuestion 外部取消（signal 句柄）', () => {
  it('流中途外部 abort → 抛 CANCELLED（已停止生成，可重发），不落入网络异常语义', async () => {
    const fetchMock = fetch as unknown as Mock;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementation(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              streamController = c;
              c.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"半"}\n\n'));
              // 不 close：模拟流挂起等待外部取消
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const external = new AbortController();
    const deltas: string[] = [];
    const pending = streamQuestion('s', REQ, (t) => deltas.push(t), external.signal);
    await vi.waitFor(() => expect(deltas).toEqual(['半']));
    // 模拟真实 fetch 的接线：signal abort → body 流以 AbortError 拒绝
    external.abort();
    streamController.error(new DOMException('Aborted', 'AbortError'));
    await expect(pending).rejects.toMatchObject({
      subCode: 'CANCELLED',
      hint: '已停止生成，可重发',
      retryable: true,
    });
    expect(deltas).toEqual(['半']);
  });

  it('请求阶段被取消（fetch 以 AbortError 拒绝 + signal 已中止）→ 同样映射 CANCELLED', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const external = new AbortController();
    external.abort();
    await expect(streamQuestion('s', REQ, () => {}, external.signal)).rejects.toMatchObject({
      subCode: 'CANCELLED',
    });
  });

  it('旧后端 JSON 信封回落路径被取消（信封体读取被 AbortError 打断）→ 同样映射 CANCELLED', async () => {
    const fetchMock = fetch as unknown as Mock;
    fetchMock.mockResolvedValue({
      headers: { get: () => 'application/json' },
      json: () => Promise.reject(new DOMException('Aborted', 'AbortError')),
    } as unknown as Response);
    const external = new AbortController();
    const pending = streamQuestion('s', REQ, () => {}, external.signal);
    external.abort();
    await expect(pending).rejects.toMatchObject({ subCode: 'CANCELLED' });
  });
});
