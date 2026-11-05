// Serveur de maquette — V39.
//
// A quoi il sert : faire tourner la VRAIE interface (frontend/app.html, sans copie ni
// doublon) avec des donnees inventees, sans base MySQL. C'est ce qui permet de regarder
// l'onglet Production et de cliquer dedans avant d'avoir des dossiers reels en base.
//
// Ce n'est PAS le serveur de l'application : il ne lit rien, n'ecrit rien, ne verifie aucun
// jeton. Il repond simplement ce qu'il faut pour que la page s'affiche.
//
//   node maquettes/serveur-maquette.js     puis    http://localhost:3100/app
//
// Identifiants : n'importe lesquels. Il peut etre supprime sans consequence.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT_MAQUETTE || 3100;
const FRONT = path.join(__dirname, '..', 'frontend');

// Un jour donne, decale d'un nombre de jours : les fixtures doivent rester credibles quelle
// que soit la date a laquelle on les regarde (un retard doit rester un retard).
function jour(decalage) {
    const d = new Date();
    d.setDate(d.getDate() + decalage);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function instant(heures) {
    return new Date(Date.now() - heures * 3600 * 1000).toISOString();
}

const EQUIPE = [
    { id: 1, nom: 'Sébastien Dumas', email: 'seb@dropstyle.fr', role: 'admin', initiales: 'SD', casquettes: ['commercial', 'prod'] },
    { id: 2, nom: 'Marie Vallet', email: 'marie@dropstyle.fr', role: 'user', initiales: 'MV', casquettes: ['commercial'] },
    { id: 3, nom: 'Léo Barnier', email: 'leo@dropstyle.fr', role: 'user', initiales: 'LB', casquettes: ['graphiste', 'prod'] },
    { id: 4, nom: 'Karim Zahra', email: 'karim@dropstyle.fr', role: 'user', initiales: 'KZ', casquettes: ['poseur'] }
];

// Les sept dossiers couvrent tous les cas que l'ecran doit savoir montrer : un retard, une
// sortie du jour, un BAT en attente, un dossier sans date, et un dossier fini.
const ORDRES = [
    {
        id: 1, numero: 'CD04831', reference: 'Marquage MASTER L2H2', client_nom: 'MARCHISIO',
        client_numero: '934', devis_externe: 'DE06750', suivi_par: 2, suivi_nom: 'Marie Vallet',
        suivi_init: 'MV', suivi_initiales: 'MV', date_sortie: jour(-2), etape: 'finition',
        bat_requis: 1, bat_valide_le: instant(72), notes: 'Vinyle DAO pour les textes, pose au Versoud.',
        details: {
            support: 'Vinyle polymère + vinyle DAO', impression: 'Quadri recto éco-solvant',
            finition: 'Plastification MAT anti-UV', faconnage: 'Découpe mi-chair + échenillage + film de transfert',
            quantite: '1 véhicule', pose_incluse: true
        },
        nb_documents: 2, created_at: instant(120), etape_le: instant(6)
    },
    {
        id: 2, numero: 'CD04855', reference: 'Totem lumineux 2,4 m', client_nom: 'BOULANGERIE LAMBERT',
        client_numero: '1021', devis_externe: 'DE06791', suivi_par: 1, suivi_nom: 'Sébastien Dumas',
        suivi_init: 'SD', date_sortie: jour(0), etape: 'impression', bat_requis: 1,
        bat_valide_le: instant(20), notes: null,
        details: { support: 'Dibond 3 mm', impression: 'Quadri recto', finition: 'Vernis anti-graffiti', quantite: '1 totem' },
        nb_documents: 1, etape_le: instant(3)
    },
    {
        id: 3, numero: 'CD04860', reference: 'Semi-covering Kangoo', client_nom: 'SARL BERTHOD',
        client_numero: '788', devis_externe: 'DE06802', suivi_par: 2, suivi_nom: 'Marie Vallet',
        suivi_init: 'MV', date_sortie: jour(1), etape: 'en_prod', bat_requis: 1,
        bat_valide_le: null, notes: 'Client en attente du BAT v2 depuis mardi.',
        details: { support: 'Vinyle polymère', impression: 'Quadri recto éco-solvant', quantite: '1 véhicule', pose_incluse: true },
        nb_documents: 1, etape_le: instant(30)
    },
    {
        id: 4, numero: 'CD04862', reference: 'Vitrophanie dépoli 6 m²', client_nom: 'CABINET MOREL',
        client_numero: '1144', devis_externe: null, suivi_par: 3, suivi_nom: 'Léo Barnier',
        suivi_init: 'LB', date_sortie: jour(2), etape: 'a_faire', bat_requis: 0, bat_valide_le: null,
        notes: null, details: { support: 'Dépoli sablé', faconnage: 'Découpe + échenillage', quantite: '6 m²' },
        nb_documents: 1, etape_le: instant(2)
    },
    {
        id: 5, numero: 'CD04864', reference: 'Lettrage 2 fourgons', client_nom: 'TRANSPORTS GALLIEN',
        client_numero: '312', devis_externe: 'DE06810', suivi_par: 1, suivi_nom: 'Sébastien Dumas',
        suivi_init: 'SD', date_sortie: jour(3), etape: 'pose', bat_requis: 1, bat_valide_le: instant(96),
        notes: 'Les deux véhicules passent le même jour.',
        details: { support: 'Vinyle polymère', faconnage: 'Découpe + transfert', quantite: '2 véhicules', pose_incluse: true },
        nb_documents: 3, etape_le: instant(1)
    },
    {
        id: 6, numero: 'CD04870', reference: 'Stickers vitrine (série 250)', client_nom: 'LE COMPTOIR DU PAIN',
        client_numero: '905', devis_externe: null, suivi_par: null, suivi_nom: null, suivi_init: null,
        date_sortie: null, etape: 'a_faire', bat_requis: 0, bat_valide_le: null,
        notes: 'À caler quand il y a un trou dans le planning.',
        details: { support: 'Vinyle monomère', quantite: '250 pièces' }, nb_documents: 0, etape_le: instant(8)
    },
    {
        id: 7, numero: 'CD04812', reference: 'Enseigne bandeau 4 m', client_nom: 'GARAGE PERRIN',
        client_numero: '640', devis_externe: 'DE06702', suivi_par: 2, suivi_nom: 'Marie Vallet',
        suivi_init: 'MV', date_sortie: jour(-5), etape: 'fini', bat_requis: 1, bat_valide_le: instant(200),
        notifie_le: instant(10), notes: null,
        details: { support: 'Dibond 3 mm', impression: 'Quadri recto', quantite: '1 enseigne' },
        nb_documents: 2, etape_le: instant(10)
    }
];

const LIBELLES = {
    a_faire: 'À faire', en_prod: 'En prod', impression: 'Impression',
    finition: 'Finition', pose: 'Pose', fini: 'Fini'
};
const ETAPES = Object.keys(LIBELLES);

// Les memes calculs que le serveur reel : c'est ce qui donne les pastilles de retard et les
// compteurs du haut.
function enrichir(o) {
    const aujourd = jour(0);
    const bloque = !!o.bat_requis && !o.bat_valide_le;
    const termine = o.etape === 'fini';
    return {
        ...o,
        etape_libelle: LIBELLES[o.etape] || o.etape,
        bat_en_attente: bloque,
        en_retard: !!o.date_sortie && !termine && !bloque && o.date_sortie < aujourd,
        pour_aujourdhui: !!o.date_sortie && !termine && o.date_sortie === aujourd
    };
}
function trier(liste) {
    return [...liste].sort((a, b) => {
        if ((a.etape === 'fini') !== (b.etape === 'fini')) return a.etape === 'fini' ? 1 : -1;
        if (!a.date_sortie !== !b.date_sortie) return a.date_sortie ? -1 : 1;
        if (a.date_sortie !== b.date_sortie) return (a.date_sortie || '') < (b.date_sortie || '') ? -1 : 1;
        return a.id - b.id;
    });
}

const MIMES = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.ico': 'image/x-icon'
};

function envoyer(res, code, objet) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(objet));
}

function servirFichier(res, fichier) {
    fs.readFile(fichier, (err, contenu) => {
        if (err) { res.writeHead(404); res.end('introuvable'); return; }
        res.writeHead(200, { 'Content-Type': MIMES[path.extname(fichier).toLowerCase()] || 'application/octet-stream' });
        res.end(contenu);
    });
}

const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chemin = url.pathname;

    if (!chemin.startsWith('/api/')) {
        const pages = { '/': 'index.html', '/app': 'app.html', '/admin': 'admin-dashboard.html', '/invitation': 'invitation.html' };
        if (pages[chemin]) return servirFichier(res, path.join(FRONT, pages[chemin]));
        // Rien d'autre que le dossier frontend n'est servi.
        const vise = path.normalize(path.join(FRONT, chemin));
        if (!vise.startsWith(FRONT)) { res.writeHead(403); return res.end('non'); }
        return servirFichier(res, vise);
    }

    let corps = '';
    req.on('data', c => { corps += c; });
    req.on('end', () => {
        const recu = corps ? (() => { try { return JSON.parse(corps); } catch (e) { return {}; } })() : {};
        const api = chemin.replace('/api', '');

        // --- connexion : n'importe quoi fonctionne, c'est une maquette ---
        if (api === '/login' || api === '/register' || api === '/auth/login' || api === '/auth/register') {
            // On renvoie ce qu'on a recu sur le souvenir : c'est ce qui permet de verifier
            // que la case de la page de connexion arrive bien jusqu'au serveur.
            console.log('connexion — souvenir :', recu.souvenir === false ? 'non' : 'oui');
            return envoyer(res, 200, { token: 'maquette', user: EQUIPE[0], souvenir: recu.souvenir !== false });
        }

        // --- production ---
        if (api === '/prod/casquettes') {
            return envoyer(res, 200, {
                casquettes: ['admin', 'commercial', 'graphiste', 'prod', 'poseur'],
                etapes: ETAPES.map(e => ({ cle: e, libelle: LIBELLES[e], autorisee: true })),
                peut_deposer: true, peut_valider_bat: true
            });
        }
        if (api === '/prod/equipe') return envoyer(res, 200, { moi: 1, membres: EQUIPE });
        if (api === '/prod/ordres' && req.method === 'GET') {
            const ordres = trier(ORDRES).map(enrichir);
            return envoyer(res, 200, {
                ordres,
                compteurs: {
                    en_retard: ordres.filter(o => o.en_retard).length,
                    aujourdhui: ordres.filter(o => o.pour_aujourdhui).length,
                    en_cours: ordres.filter(o => o.etape !== 'a_faire' && o.etape !== 'fini').length,
                    bat_en_attente: ordres.filter(o => o.bat_en_attente).length,
                    par_etape: ETAPES.reduce((a, e) => ({ ...a, [e]: ordres.filter(o => o.etape === e).length }), {})
                }
            });
        }
        const detail = api.match(/^\/prod\/ordres\/(\d+)$/);
        if (detail && req.method === 'GET') {
            const o = ORDRES.find(x => x.id === Number(detail[1]));
            if (!o) return envoyer(res, 404, { error: 'Dossier introuvable' });
            const avant = ETAPES.slice(0, ETAPES.indexOf(o.etape));
            return envoyer(res, 200, {
                ordre: enrichir(o),
                historique: [
                    ...(o.bat_valide_le ? [{ etape: 'bat', commentaire: 'BAT validé', nom: 'Marie Vallet', created_at: o.bat_valide_le }] : []),
                    ...avant.map((e, i) => ({
                        etape: ETAPES[ETAPES.indexOf(e) + 1], etape_avant: e, commentaire: null,
                        nom: i % 2 ? 'Léo Barnier' : 'Sébastien Dumas', created_at: instant(40 - i * 8)
                    })),
                    { etape: 'a_faire', commentaire: 'Dossier créé', nom: 'Marie Vallet', created_at: o.created_at || instant(100) }
                ].reverse(),
                documents: Array.from({ length: o.nb_documents }, (_, i) => ({
                    id: o.id * 10 + i, nom: i === 0 ? `${o.numero}.pdf` : `BAT_v${i}.pdf`,
                    genre: i === 0 ? 'fiche' : 'bat', mime: 'application/pdf', poids: 180000 + i * 40000
                }))
            });
        }
        const etape = api.match(/^\/prod\/ordres\/(\d+)\/etape$/);
        if (etape && req.method === 'PUT') {
            const o = ORDRES.find(x => x.id === Number(etape[1]));
            if (!o) return envoyer(res, 404, { error: 'Dossier introuvable' });
            const avant = ETAPES.indexOf(o.etape), apres = ETAPES.indexOf(recu.etape);
            if (apres < 0) return envoyer(res, 400, { error: 'Étape inconnue' });
            if (apres > avant + 1) return envoyer(res, 400, { error: 'Une étape à la fois : passez par l\'étape précédente' });
            if (apres >= ETAPES.indexOf('impression') && o.bat_requis && !o.bat_valide_le) {
                return envoyer(res, 409, { error: 'Le BAT n\'est pas validé : impression bloquée' });
            }
            o.etape = recu.etape;
            o.etape_le = new Date().toISOString();
            const prevenir = recu.etape === 'fini' && o.suivi_par && !o.notifie_le;
            if (prevenir) o.notifie_le = new Date().toISOString();
            return envoyer(res, 200, { message: 'OK', etape: o.etape, notifie: !!prevenir });
        }
        const bat = api.match(/^\/prod\/ordres\/(\d+)\/bat$/);
        if (bat && req.method === 'PUT') {
            const o = ORDRES.find(x => x.id === Number(bat[1]));
            if (!o) return envoyer(res, 404, { error: 'Dossier introuvable' });
            o.bat_requis = 1;
            o.bat_valide_le = recu.valide === false ? null : new Date().toISOString();
            return envoyer(res, 200, { message: 'OK', bat_valide: !!o.bat_valide_le });
        }
        if (api === '/prod/ordres' && req.method === 'POST') {
            const id = Math.max(...ORDRES.map(o => o.id)) + 1;
            ORDRES.push({
                id, etape: 'a_faire', nb_documents: 0, bat_valide_le: null, suivi_nom: null,
                ...recu, bat_requis: recu.bat_requis ? 1 : 0,
                date_sortie: recu.date_sortie || null, created_at: new Date().toISOString()
            });
            return envoyer(res, 201, { message: 'OK', id });
        }
        if (api === '/prod/documents' && req.method === 'POST') return envoyer(res, 201, { message: 'OK', id: 99 });
        if (api === '/prod/lire-fiche') {
            // Ce que Claude renvoie sur la vraie fiche CD04831, pour voir le bloc de lecture.
            return envoyer(res, 200, {
                numero: 'CD04831', reference: 'Marquage MASTER L2H2', client_nom: 'MARCHISIO',
                client_numero: '934', devis_externe: 'DE06750', suivi_initiales: 'MV',
                support: 'Vinyle polymère + vinyle DAO', impression: 'Quadri recto éco-solvant',
                finition: 'Plastification MAT anti-UV',
                faconnage: 'Découpe mi-chair + échenillage + pose de film de transfert',
                quantite: '1 véhicule', pose_incluse: true, confiance: 'haute',
                commentaire: 'Fiche lue sans difficulté : tous les champs étaient présents.'
            });
        }
        if (api.match(/^\/admin\/users\/\d+\/casquettes$/)) return envoyer(res, 200, { message: 'OK' });

        // --- le reste de l'application : juste de quoi ne pas bloquer la page ---
        if (api === '/parametres') return envoyer(res, 200, { coefficient: 2, tva: 20 });
        if (api === '/equipe') return envoyer(res, 200, { moi: 1, membres: EQUIPE });
        if (api === '/notifications') return envoyer(res, 200, { notifications: [], nonLus: 0 });
        if (api === '/push/cle') return envoyer(res, 200, { cle: null });
        if (api === '/zones-vehicule') return envoyer(res, 200, { zones: [] });
        if (api === '/devis') return envoyer(res, 200, []);
        if (api.startsWith('/classement') || api.startsWith('/stats')) return envoyer(res, 200, []);
        return envoyer(res, 200, []);
    });
});

serveur.listen(PORT, () => {
    console.log(`Maquette DropStyle — http://localhost:${PORT}/app`);
    console.log('Donnees inventees, aucune base de donnees. Connexion : n\'importe quel identifiant.');
});
