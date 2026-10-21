// Service worker minimal. Il existe parce que les navigateurs l'exigent pour proposer
// l'installation — et il ne met RIEN en cache.
//
// Aucune mise en cache volontairement : le logiciel doit toujours afficher les tarifs et
// les devis a jour. Un cache mal maitrise servirait d'anciens prix, ce qui est bien pire
// qu'une page qui ne s'ouvre pas hors connexion.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });

// V38 — notifications systeme. Elles arrivent meme logiciel ferme, ce que la banniere
// dans la page ne peut pas faire.
self.addEventListener('push', (e) => {
    let d = {};
    // Une charge illisible ne doit pas faire disparaitre la notification : mieux vaut
    // une alerte generique que rien du tout.
    try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
    const titre = d.titre || 'DropStyle';
    e.waitUntil(self.registration.showNotification(titre, {
        body: [d.de, d.message].filter(Boolean).join(' — ') || 'Vous avez un nouveau message.',
        icon: '/img/icone-192.png',
        badge: '/img/icone-192.png',
        tag: 'dropstyle-notif',       // une seule pastille a l'ecran, remplacee a chaque fois
        renotify: true,
        data: { url: d.url || '/app' }
    }));
});

// Un clic ramene vers une fenetre DEJA ouverte quand il y en a une : sans cela, chaque
// notification ouvrirait un onglet de plus.
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const cible = (e.notification.data && e.notification.data.url) || '/app';
    e.waitUntil((async () => {
        const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const f of fenetres) {
            if (f.url.includes(cible) && 'focus' in f) return f.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(cible);
    })());
});
