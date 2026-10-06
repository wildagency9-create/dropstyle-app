// Service worker minimal. Il existe parce que les navigateurs l'exigent pour proposer
// l'installation — et il ne fait RIEN d'autre que relayer les requetes au reseau.
//
// Aucune mise en cache volontairement : le logiciel doit toujours afficher les tarifs et
// les devis a jour. Un cache mal maitrise servirait d'anciens prix, ce qui est bien pire
// qu'une page qui ne s'ouvre pas hors connexion.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
