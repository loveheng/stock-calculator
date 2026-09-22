/**
 * @file push-sw.js
 * @description Web Push 事件处理脚本：由 vite-plugin-pwa（generateSW）经 workbox
 *              importScripts 注入主 Service Worker（见 vite.config.ts workbox.importScripts）。
 *              处理 push（展示系统通知）与 notificationclick（聚焦或打开目标页面）。
 * @layer ServiceWorker
 */
/* eslint-env serviceworker */

// push 事件：payload 为服务端 PushDeliveryService 组装的轻量 JSON {title, body, url}
self.addEventListener('push', (event) => {
  let data = { title: '做T账本', body: '您有一条新通知', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // payload 非 JSON 时用默认文案
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'stock-calc-push',
      data: { url: data.url || '/' },
    }),
  );
});

// 通知点击：已有窗口则聚焦并导航，否则新开目标页
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (client.navigate && client.url !== url) {
            try { await client.navigate(url); } catch (e) { /* 跨路由导航失败留在原页 */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
