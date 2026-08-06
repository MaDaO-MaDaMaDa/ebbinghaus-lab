const CACHE_NAME = 'ebbinghaus-v6';
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

// IndexedDB helpers for SW to store auth token
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('EbbinghausSWStore', 1);
    request.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('config');
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject('IDB error: ' + e);
  });
}

function saveToken(token) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite');
      if (token === null) {
        tx.objectStore('config').delete('authToken');
      } else {
        tx.objectStore('config').put(token, 'authToken');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject();
    });
  });
}

function getToken() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('authToken');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject();
    });
  });
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_TOKEN') {
    event.waitUntil(saveToken(event.data.token));
  }
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    getToken().then(async (token) => {
      if (!token) return;

      const vapidRes = await fetch('/api/notifications/vapid-key');
      const { publicKey } = await vapidRes.json();
      if (!publicKey) return;
      
      const padding = '='.repeat((4 - publicKey.length % 4) % 4);
      const base64 = (publicKey + padding).replace(/\-/g, '+').replace(/_/g, '/');
      const rawData = self.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: outputArray
      });

      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(newSub)
      });
    }).catch(err => console.error('pushsubscriptionchange failed', err))
  );
});
