const CACHE_NAME = 'ebbinghaus-v4';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Pass API requests directly to network
  if (event.request.url.includes('/api/')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

self.addEventListener('push', function(event) {
  // Empty payload push: We must fetch the notification details from the server
  event.waitUntil(
    fetch('/api/notifications/pending')
      .then(response => {
        if (!response.ok) throw new Error('Failed to fetch pending notification');
        return response.json();
      })
      .then(data => {
        const title = data.title || '復習の時間です！';
        const options = {
          body: data.body || 'エビングハウス・ラボで本日の学習ログを復習しましょう。',
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'ebbinghaus-review',
          data: { url: '/' }
        };
        return self.registration.showNotification(title, options);
      })
      .catch(err => {
        console.error('Push event error:', err);
        return self.registration.showNotification('復習の時間です！', {
          body: 'エビングハウス・ラボを開いて復習項目を確認しましょう。',
          icon: '/icon.svg'
        });
      })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(new URL(urlToOpen, self.location.origin).href) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
