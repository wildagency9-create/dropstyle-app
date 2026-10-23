const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');

dotenv.config();
const app = express();

const JWT_SECRET = process.env.JWT_SECRET || (() => {
    console.error('⚠️  JWT_SECRET manquant : secret temporaire généré pour ce démarrage (les sessions existantes seront invalidées à chaque redémarrage). Définir JWT_SECRET dans les variables d\'environnement.');
    return require('crypto').randomBytes(32).toString('hex');
})();

// Railway place l'application derriere son proxy : sans ceci, express-rate-limit voit
// l'adresse du proxy pour tout le monde et compte les tentatives de connexion de tous les
// utilisateurs dans le meme compteur. 1 = on ne fait confiance qu'au premier relais.
app.set('trust proxy', 1);

app.use(cors());
// V26 — le corps d'une requete est plafonne a 100 ko par defaut : une photo de vehicule
// ne passerait pas. Seule la route des photos accepte davantage ; inutile d'ouvrir la
// porte sur tous les autres endpoints, qui n'echangent que de petits objets JSON.
const jsonStandard = express.json();
const jsonPhoto = express.json({ limit: '4mb' });
app.use((req, res, next) => (req.path === '/api/photos' ? jsonPhoto : jsonStandard)(req, res, next));
app.use(express.static(path.join(__dirname, 'frontend')));

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'dropstyle',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// V25 — filet de securite sur les connexions. Rend TOUJOURS la connexion au pool : que la
// requete reussisse, qu'elle echoue, ou que le handler sorte par un return anticipe
// (res.status(404) et compagnie), le finally s'execute. Sans ce filet, chaque erreur SQL
// gardait une connexion pour elle ; au bout de 10 (la taille du pool) plus aucune requete
// n'aboutissait et l'application restait muette jusqu'au redemarrage.
async function avecConnexion(travail) {
    const conn = await pool.getConnection();
    try {
        return await travail(conn);
    } finally {
        await conn.release();
    }
}

// Variante pour les fonctions qui acceptent une connexion deja ouverte par l'appelant :
// dans ce cas c'est a lui de la rendre, on n'y touche pas.
async function avecConnexionPartagee(connexionExistante, travail) {
    if (connexionExistante) return await travail(connexionExistante);
    return await avecConnexion(travail);
}

// V6 — creation idempotente des tables/colonnes du moteur unifie.
// Chaque requete est independante : un echec n'empeche pas les suivantes, et la fonction
// est rappelee par les endpoints concernes, donc les tables finissent toujours par exister.
async function ensureV6Tables(existingConn) {
    return avecConnexionPartagee(existingConn, async (conn) => {
        const queries = [
            `CREATE TABLE IF NOT EXISTS laminations (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, prix DECIMAL(10, 2) NOT NULL, laizes VARCHAR(100))`,
            `CREATE TABLE IF NOT EXISTS tapes (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, prix DECIMAL(10, 2) NOT NULL, laizes VARCHAR(100))`,
            `ALTER TABLE vinyles ADD COLUMN laizes VARCHAR(100)`,
            `ALTER TABLE materiaux ADD COLUMN format_plaque VARCHAR(50)`,
            `ALTER TABLE poseurs ADD COLUMN type_prix VARCHAR(10) DEFAULT 'vente'`
        ];
        for (const q of queries) {
            try { await conn.query(q); }
            catch (e) { if (!/Duplicate column/i.test(e.message)) console.error('V6 init:', e.message); }
        }
    });
}

// V8 — suivi de stock (m²) sur les tables matiere, independant du moteur de prix.
// stock_m2 NULL = article non suivi. seuil_alerte NULL = utilise le seuil par defaut (parametres).
async function ensureV8Tables(existingConn) {
    return avecConnexionPartagee(existingConn, async (conn) => {
        const queries = [
            `ALTER TABLE vinyles ADD COLUMN stock_m2 DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE vinyles ADD COLUMN seuil_alerte DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE vinyles ADD COLUMN alerte_envoyee TINYINT(1) DEFAULT 0`,
            `ALTER TABLE materiaux ADD COLUMN stock_m2 DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE materiaux ADD COLUMN seuil_alerte DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE materiaux ADD COLUMN alerte_envoyee TINYINT(1) DEFAULT 0`,
            `ALTER TABLE laminations ADD COLUMN stock_m2 DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE laminations ADD COLUMN seuil_alerte DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE laminations ADD COLUMN alerte_envoyee TINYINT(1) DEFAULT 0`,
            `ALTER TABLE tapes ADD COLUMN stock_m2 DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE tapes ADD COLUMN seuil_alerte DECIMAL(10, 2) DEFAULT NULL`,
            `ALTER TABLE tapes ADD COLUMN alerte_envoyee TINYINT(1) DEFAULT 0`
        ];
        for (const q of queries) {
            try { await conn.query(q); }
            catch (e) { if (!/Duplicate column/i.test(e.message)) console.error('V8 init:', e.message); }
        }
    });
}

// V9 — nom du client sur les devis (saisi au moment de l'enregistrement), pour retrouver
// un devis dans l'historique autrement que par son montant.
async function ensureV9Tables(existingConn) {
    return avecConnexionPartagee(existingConn, async (conn) => {
        try { await conn.query(`ALTER TABLE devis ADD COLUMN client VARCHAR(255) DEFAULT NULL`); }
        catch (e) { if (!/Duplicate column/i.test(e.message)) console.error('V9 init:', e.message); }
    });
}

// V11 — equipe, clients/prospects et notifications internes.
// equipe_id sur users : tous les membres d'une meme entreprise partagent tarifs, devis et clients.
// Backfill equipe_id = id, donc chaque compte existant devient sa propre equipe : rien ne bouge
// pour les donnees deja en place, et aucune donnee ne fuite d'un compte a l'autre.
const SOURCES_PAR_DEFAUT = [
    'Site web / Google', 'Réseaux sociaux', 'Bouche-à-oreille', 'Recommandation d\'un client',
    'Connaissance', 'Soirée business / réseau pro', 'Véhicule ou chantier vu en circulation',
    'Salon / foire', 'Apporteur d\'affaires', 'Confrère / sous-traitance',
    'Appel d\'offres / collectivité', 'Prospection sortante', 'Autre'
];

// Une fois la V11 en place, on ne rejoue plus les migrations a chaque appel d'API :
// sans ce drapeau, chaque requete relance 3 CREATE, 2 ALTER et 1 UPDATE pour rien.
// Le drapeau est propre au processus : un redemarrage rejoue la verification.
let v11Prete = false;

// Faux tant que la verification n'a pas eu lieu : mieux vaut un devis sans saisie qu'un
// devis qu'on ne peut pas enregistrer.
let devisPorteLaSaisie = false;

async function ensureV11Tables(existingConn) {
    if (v11Prete && !existingConn) return;
    let echec = false;
    // Le tableau est construit avant d'ouvrir la connexion : inutile d'en retenir une
    // pendant ce temps.
    const queries = [
        `ALTER TABLE users ADD COLUMN equipe_id INT DEFAULT NULL`,
        `UPDATE users SET equipe_id = id WHERE equipe_id IS NULL`,
        `CREATE TABLE IF NOT EXISTS clients (
            id INT PRIMARY KEY AUTO_INCREMENT,
            equipe_id INT NOT NULL,
            nom VARCHAR(255) NOT NULL,
            type ENUM('prospect', 'client') DEFAULT 'prospect',
            source VARCHAR(100) DEFAULT NULL,
            email VARCHAR(255) DEFAULT NULL,
            telephone VARCHAR(50) DEFAULT NULL,
            notes TEXT DEFAULT NULL,
            auteur_id INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_equipe (equipe_id)
        )`,
        `CREATE TABLE IF NOT EXISTS sources_client (
            id INT PRIMARY KEY AUTO_INCREMENT,
            equipe_id INT NOT NULL,
            nom VARCHAR(100) NOT NULL,
            ordre INT DEFAULT 0,
            INDEX idx_equipe (equipe_id)
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
            id INT PRIMARY KEY AUTO_INCREMENT,
            equipe_id INT NOT NULL,
            de_user_id INT NOT NULL,
            vers_user_id INT NOT NULL,
            type VARCHAR(20) NOT NULL DEFAULT 'message',
            titre VARCHAR(255) NOT NULL,
            message TEXT DEFAULT NULL,
            ref_type VARCHAR(20) DEFAULT NULL,
            ref_id INT DEFAULT NULL,
            date_rdv DATETIME DEFAULT NULL,
            lu TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_destinataire (vers_user_id, lu)
        )`,
        `ALTER TABLE devis ADD COLUMN client_id INT DEFAULT NULL`,
        `ALTER TABLE devis ADD COLUMN auteur_id INT DEFAULT NULL`,
        // V12 — invitations. Le jeton est l'element sensible : il vaut une creation de compte
        // dans l'equipe, d'ou l'expiration et l'usage unique (utilise_le).
        `CREATE TABLE IF NOT EXISTS invitations (
            id INT PRIMARY KEY AUTO_INCREMENT,
            equipe_id INT NOT NULL,
            email VARCHAR(255) NOT NULL,
            token VARCHAR(64) NOT NULL UNIQUE,
            role ENUM('user', 'admin') DEFAULT 'user',
            cree_par INT DEFAULT NULL,
            expire_le DATETIME NOT NULL,
            utilise_le DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_equipe (equipe_id)
        )`,
        // V13 — suivi des connexions. Volontairement minimal : on enregistre quand et
        // combien de fois, pas une duree de presence, qui ne mesurerait qu'un onglet ouvert.
        `ALTER TABLE users ADD COLUMN derniere_connexion DATETIME DEFAULT NULL`,
        `ALTER TABLE users ADD COLUMN nb_connexions INT DEFAULT 0`,
        // V14 — suivi des devis. Les devis existants restent au statut 'calcule' : on ignore
        // s'ils ont ete acceptes, et les compter comme valides gonflerait le chiffre d'affaires.
        `ALTER TABLE devis ADD COLUMN statut VARCHAR(20) NOT NULL DEFAULT 'calcule'`,
        `ALTER TABLE devis ADD COLUMN statut_le DATETIME DEFAULT NULL`,
        `ALTER TABLE devis ADD COLUMN statut_par INT DEFAULT NULL`,
        // V17 — ajustement commercial. `ht` porte desormais le prix REELLEMENT VENDU (c'est lui
        // qui compte dans le CA), et `ht_calcule` le prix sorti du moteur. Les devis anterieurs
        // n'ont pas d'ajustement : ht_calcule reste NULL et vaut alors ht, ce qui est exact.
        `ALTER TABLE devis ADD COLUMN ht_calcule DECIMAL(10, 2) DEFAULT NULL`,
        `ALTER TABLE devis ADD COLUMN ajustement_pct DECIMAL(6, 2) DEFAULT NULL`,
        // V33 — etat du formulaire au moment du calcul : c'est ce qui rend un devis
        // modifiable. Les devis plus anciens gardent NULL et ne sont pas recalculables.
        `ALTER TABLE devis ADD COLUMN saisie JSON DEFAULT NULL`,
        // V38 — abonnements aux notifications systeme. Un enregistrement par appareil :
        // le meme utilisateur peut etre sur son telephone et sur l'ordinateur de l'atelier.
        `CREATE TABLE IF NOT EXISTS push_abonnements (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            equipe_id INT NOT NULL,
            endpoint VARCHAR(500) NOT NULL,
            p256dh VARCHAR(255) NOT NULL,
            auth VARCHAR(255) NOT NULL,
            agent VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_endpoint (endpoint(255)),
            INDEX idx_user (user_id)
        )`,
        `ALTER TABLE devis ADD COLUMN modifie_le DATETIME DEFAULT NULL`,
        `ALTER TABLE devis ADD COLUMN modifie_par INT DEFAULT NULL`,
        // V15 — trace des recapitulatifs deja envoyes. En base et non en memoire : un
        // redemarrage du serveur ne doit pas provoquer un second envoi.
        `CREATE TABLE IF NOT EXISTS recaps_envoyes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            equipe_id INT NOT NULL,
            periode VARCHAR(16) NOT NULL,
            envoye_le DATETIME NOT NULL,
            UNIQUE KEY uniq_equipe_periode (equipe_id, periode)
        )`
    ];
    await avecConnexionPartagee(existingConn, async (conn) => {
        for (const q of queries) {
            try { await conn.query(q); }
            catch (e) {
                // "Duplicate column" = migration deja appliquee, ce n'est pas un echec.
                if (!/Duplicate column/i.test(e.message)) { echec = true; console.error('V11 init:', e.message); }
            }
        }
        // V33 — on ne SUPPOSE pas que la colonne existe : une migration avalee par le
        // catch ci-dessus ferait echouer tous les enregistrements de devis.
        try {
            const [cols] = await conn.query("SHOW COLUMNS FROM devis LIKE 'saisie'");
            devisPorteLaSaisie = cols.length > 0;
            if (!devisPorteLaSaisie) console.error('V33 : colonne saisie absente — les devis ne seront pas reprenables.');
        } catch (e) { devisPorteLaSaisie = false; console.error('V33 verif colonne :', e.message); }
    });
    if (!echec) v11Prete = true;
}

// Les sources sont creees a la demande, par equipe, et restent modifiables depuis l'admin :
// une equipe qui a supprime une source ne la voit pas revenir (on ne reseme que si la table est vide).
async function ensureSourcesEquipe(conn, equipeId) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM sources_client WHERE equipe_id = ?', [equipeId]);
    if (n > 0) return;
    for (let i = 0; i < SOURCES_PAR_DEFAUT.length; i++) {
        await conn.query('INSERT INTO sources_client (equipe_id, nom, ordre) VALUES (?, ?, ?)', [equipeId, SOURCES_PAR_DEFAUT[i], i]);
    }
}

// V26 — photos du vehicule. Les photos sont prises AVANT que le devis existe : elles
// arrivent donc avec un identifiant de brouillon genere par le navigateur, et sont
// rattachees au devis au moment de son enregistrement. Les octets vivent en base et non
// sur le disque : Railway efface le systeme de fichiers a chaque redeploiement.
const FACES_PHOTO = ['gauche', 'droite', 'avant', 'arriere', 'toit'];
// V34 — l'apercu client est range avec les photos : meme table, meme rattachement au
// devis. Le prefixe 'ap-' garde les deux series distinctes, et un apercu refait remplace
// le precedent au lieu de s'empiler.
const FACES_APERCU = FACES_PHOTO.map(f => 'ap-' + f);
const FACES_ACCEPTEES = [...FACES_PHOTO, ...FACES_APERCU];
const POIDS_MAX_PHOTO = 900 * 1024;   // large pour une photo recompressee a 1400 px par le navigateur
const JOURS_BROUILLON = 7;            // au-dela, un brouillon sans devis est considere abandonne

// Meme drapeau que la V11 : sans lui, chaque envoi de photo rejouerait un CREATE TABLE
// pour rien. Il est propre au processus, un redemarrage refait la verification.
let v26Prete = false;

async function ensureV26Tables(existingConn) {
    if (v26Prete && !existingConn) return;
    return avecConnexionPartagee(existingConn, async (conn) => {
        try {
            await conn.query(`CREATE TABLE IF NOT EXISTS devis_photos (
                id INT PRIMARY KEY AUTO_INCREMENT,
                equipe_id INT NOT NULL,
                devis_id INT DEFAULT NULL,
                brouillon_id VARCHAR(40) DEFAULT NULL,
                face VARCHAR(16) NOT NULL,
                mime VARCHAR(40) NOT NULL,
                octets MEDIUMBLOB NOT NULL,
                largeur INT DEFAULT NULL,
                hauteur INT DEFAULT NULL,
                poids INT DEFAULT NULL,
                auteur_id INT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_brouillon (equipe_id, brouillon_id),
                INDEX idx_devis (devis_id)
            )`);
            v26Prete = true;
        } catch (e) { console.error('V26 init:', e.message); }
    });
}

// V28 — zones du vehicule. Le moteur ne connaissait qu'une surface globale par type de
// marquage ; ces zones permettent de designer ce qu'on habille reellement.
//
// REGLE QUI TIENT TOUT : pour chaque type, la somme des zones retombe exactement sur la
// surface « covering total » validee le 26/08 (citadine 20, berline 25, SUV 28, utilitaire
// 25, fourgon 40, camion 35). Ce decoupage ne rediscute donc aucun chiffre deja valide, il
// le repartit. Une zone « par cote » compte double (gauche + droit).
//
// Surfaces HORS chutes, comme la grille d'origine : le coefficient P10 s'applique ensuite.
const ZONES_DEFAUT = {
    citadine: [
        { cle: 'aile_av',   nom: 'Aile avant',        face: 'cote',    par_cote: 1, m2: 0.60 },
        { cle: 'porte_av',  nom: 'Portière avant',    face: 'cote',    par_cote: 1, m2: 1.20 },
        { cle: 'porte_ar',  nom: 'Portière arrière',  face: 'cote',    par_cote: 1, m2: 1.00 },
        { cle: 'aile_ar',   nom: 'Aile arrière',      face: 'cote',    par_cote: 1, m2: 0.70 },
        { cle: 'vitres',    nom: 'Vitres latérales',  face: 'cote',    par_cote: 1, m2: 0.80 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 0.40 },
        { cle: 'capot',     nom: 'Capot',             face: 'avant',   par_cote: 0, m2: 1.80 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 1.20 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 0.90 },
        { cle: 'hayon',     nom: 'Hayon',             face: 'arriere', par_cote: 0, m2: 1.80 },
        { cle: 'lunette',   nom: 'Lunette arrière',   face: 'arriere', par_cote: 0, m2: 0.60 },
        { cle: 'pc_ar',     nom: 'Pare-chocs arrière',face: 'arriere', par_cote: 0, m2: 0.80 },
        { cle: 'toit',      nom: 'Toit',              face: 'toit',    par_cote: 0, m2: 3.50 }
    ],
    berline: [
        { cle: 'aile_av',   nom: 'Aile avant',        face: 'cote',    par_cote: 1, m2: 0.70 },
        { cle: 'porte_av',  nom: 'Portière avant',    face: 'cote',    par_cote: 1, m2: 1.40 },
        { cle: 'porte_ar',  nom: 'Portière arrière',  face: 'cote',    par_cote: 1, m2: 1.20 },
        { cle: 'aile_ar',   nom: 'Aile arrière',      face: 'cote',    par_cote: 1, m2: 0.90 },
        { cle: 'vitres',    nom: 'Vitres latérales',  face: 'cote',    par_cote: 1, m2: 1.00 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 0.50 },
        { cle: 'capot',     nom: 'Capot',             face: 'avant',   par_cote: 0, m2: 2.20 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 1.40 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 1.00 },
        { cle: 'coffre',    nom: 'Coffre',            face: 'arriere', par_cote: 0, m2: 1.80 },
        { cle: 'lunette',   nom: 'Lunette arrière',   face: 'arriere', par_cote: 0, m2: 0.70 },
        { cle: 'pc_ar',     nom: 'Pare-chocs arrière',face: 'arriere', par_cote: 0, m2: 0.90 },
        { cle: 'toit',      nom: 'Toit',              face: 'toit',    par_cote: 0, m2: 5.60 }
    ],
    suv: [
        { cle: 'aile_av',   nom: 'Aile avant',        face: 'cote',    par_cote: 1, m2: 0.80 },
        { cle: 'porte_av',  nom: 'Portière avant',    face: 'cote',    par_cote: 1, m2: 1.50 },
        { cle: 'porte_ar',  nom: 'Portière arrière',  face: 'cote',    par_cote: 1, m2: 1.30 },
        { cle: 'aile_ar',   nom: 'Aile arrière',      face: 'cote',    par_cote: 1, m2: 1.00 },
        { cle: 'vitres',    nom: 'Vitres latérales',  face: 'cote',    par_cote: 1, m2: 1.10 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 0.60 },
        { cle: 'capot',     nom: 'Capot',             face: 'avant',   par_cote: 0, m2: 2.40 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 1.50 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 1.10 },
        { cle: 'hayon',     nom: 'Hayon',             face: 'arriere', par_cote: 0, m2: 2.20 },
        { cle: 'lunette',   nom: 'Lunette arrière',   face: 'arriere', par_cote: 0, m2: 0.80 },
        { cle: 'pc_ar',     nom: 'Pare-chocs arrière',face: 'arriere', par_cote: 0, m2: 1.00 },
        { cle: 'toit',      nom: 'Toit',              face: 'toit',    par_cote: 0, m2: 6.40 }
    ],
    utilitaire: [
        { cle: 'aile_av',   nom: 'Aile avant',        face: 'cote',    par_cote: 1, m2: 0.80 },
        { cle: 'porte_av',  nom: 'Portière avant',    face: 'cote',    par_cote: 1, m2: 1.60 },
        { cle: 'flanc',     nom: 'Panneau latéral',   face: 'cote',    par_cote: 1, m2: 3.00 },
        { cle: 'vitres',    nom: 'Vitre latérale',    face: 'cote',    par_cote: 1, m2: 0.50 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 0.60 },
        { cle: 'capot',     nom: 'Capot',             face: 'avant',   par_cote: 0, m2: 2.20 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 1.10 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 0.90 },
        { cle: 'portes_ar', nom: 'Portes arrière',    face: 'arriere', par_cote: 0, m2: 2.60 },
        { cle: 'pc_ar',     nom: 'Pare-chocs arrière',face: 'arriere', par_cote: 0, m2: 0.80 },
        { cle: 'toit',      nom: 'Toit',              face: 'toit',    par_cote: 0, m2: 4.40 }
    ],
    fourgon: [
        { cle: 'aile_av',   nom: 'Aile avant',        face: 'cote',    par_cote: 1, m2: 0.90 },
        { cle: 'porte_av',  nom: 'Portière avant',    face: 'cote',    par_cote: 1, m2: 1.80 },
        { cle: 'flanc',     nom: 'Panneau latéral',   face: 'cote',    par_cote: 1, m2: 6.50 },
        { cle: 'vitres',    nom: 'Vitre latérale',    face: 'cote',    par_cote: 1, m2: 0.60 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 0.90 },
        { cle: 'capot',     nom: 'Capot',             face: 'avant',   par_cote: 0, m2: 1.60 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 1.60 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 1.20 },
        { cle: 'portes_ar', nom: 'Portes arrière',    face: 'arriere', par_cote: 0, m2: 5.00 },
        { cle: 'pc_ar',     nom: 'Pare-chocs arrière',face: 'arriere', par_cote: 0, m2: 1.00 },
        { cle: 'toit',      nom: 'Toit',              face: 'toit',    par_cote: 0, m2: 8.20 }
    ],
    camion: [
        { cle: 'porte_cab', nom: 'Portière cabine',   face: 'cote',    par_cote: 1, m2: 2.00 },
        { cle: 'flanc',     nom: 'Flanc de caisse',   face: 'cote',    par_cote: 1, m2: 10.00 },
        { cle: 'bas_caisse',nom: 'Bas de caisse',     face: 'cote',    par_cote: 1, m2: 1.20 },
        { cle: 'calandre',  nom: 'Calandre',          face: 'avant',   par_cote: 0, m2: 2.00 },
        { cle: 'parebrise', nom: 'Pare-brise',        face: 'avant',   par_cote: 0, m2: 2.20 },
        { cle: 'pc_av',     nom: 'Pare-chocs avant',  face: 'avant',   par_cote: 0, m2: 1.40 },
        { cle: 'portes_ar', nom: 'Portes arrière',    face: 'arriere', par_cote: 0, m2: 2.00 },
        { cle: 'toit',      nom: 'Pavillon cabine',   face: 'toit',    par_cote: 0, m2: 1.00 }
    ]
};

// Surface totale d'un type, zones « par cote » comptees deux fois.
function surfaceTotaleZones(zones) {
    return zones.reduce((s, z) => s + Number(z.m2 !== undefined ? z.m2 : z.surface_m2) * (z.par_cote ? 2 : 1), 0);
}

let v28Prete = false;
let v28Echec = null;   // message du dernier echec de creation, remonte a l'ecran

async function ensureV28Tables(existingConn) {
    if (v28Prete && !existingConn) return;
    return avecConnexionPartagee(existingConn, async (conn) => {
        try {
            await conn.query(`CREATE TABLE IF NOT EXISTS zones_vehicule (
                id INT PRIMARY KEY AUTO_INCREMENT,
                equipe_id INT NOT NULL,
                type_vehicule VARCHAR(20) NOT NULL,
                cle VARCHAR(40) NOT NULL,
                nom VARCHAR(80) NOT NULL,
                face VARCHAR(16) NOT NULL,
                par_cote TINYINT(1) DEFAULT 0,
                surface_m2 DECIMAL(6, 2) NOT NULL,
                ordre INT DEFAULT 0,
                UNIQUE KEY uniq_equipe_zone (equipe_id, type_vehicule, cle),
                INDEX idx_equipe_type (equipe_id, type_vehicule)
            )`);
            v28Prete = true;
            v28Echec = null;
        } catch (e) {
            // On n'interrompt pas le demarrage pour autant, mais on garde la raison : sans
            // elle, l'ecran des zones restait vide sans que personne puisse dire pourquoi.
            v28Echec = e.message;
            console.error('V28 init:', e.message);
        }
    });
}

// Semees par equipe a la demande, comme les sources d'acquisition : une equipe qui a
// ajuste ses surfaces ne les voit pas revenir aux valeurs d'origine.
async function ensureZonesEquipe(conn, equipeId) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM zones_vehicule WHERE equipe_id = ?', [equipeId]);
    if (n > 0) return;
    // Les 69 zones partent en UNE requete. Ligne par ligne, c'etaient 69 allers-retours
    // vers une base distante : assez long pour que la requete HTTP soit coupee avant la fin,
    // et l'ecran des zones restait vide sans explication.
    const lignes = [], params = [];
    for (const [type, zones] of Object.entries(ZONES_DEFAUT)) {
        zones.forEach((z, i) => {
            lignes.push('(?, ?, ?, ?, ?, ?, ?, ?)');
            params.push(equipeId, type, z.cle, z.nom, z.face, z.par_cote, z.m2, i);
        });
    }
    if (!lignes.length) return;
    await conn.query(
        'INSERT INTO zones_vehicule (equipe_id, type_vehicule, cle, nom, face, par_cote, surface_m2, ordre) VALUES '
        + lignes.join(', '), params);
}

// V7 — kits signaletique a prix fixe (roll-up / totem), meme logique que les forfaits vehicule.
async function ensureV7Tables(existingConn) {
    return avecConnexionPartagee(existingConn, async (conn) => {
        try { await conn.query(`CREATE TABLE IF NOT EXISTS kits_signaletique (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, prix DECIMAL(10, 2) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`); }
        catch (e) { console.error('V7 init:', e.message); }
    });
}

async function initDB() {
    // Meme motif que verifierRecaps : la connexion est rendue dans le finally, donc une
    // requete en echec (table verrouillee, base indisponible) ne la retient pas.
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(`CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, nom VARCHAR(255) NOT NULL, role ENUM('user', 'admin') DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS vinyles (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, name VARCHAR(255) NOT NULL, price DECIMAL(10, 2) NOT NULL, type VARCHAR(50), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS materiaux (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, support VARCHAR(255) NOT NULL, price DECIMAL(10, 2) NOT NULL, categorie VARCHAR(50), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS poseurs (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, jour DECIMAL(10, 2) NOT NULL, demijour DECIMAL(10, 2) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS impressions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, format VARCHAR(50) NOT NULL, grammage VARCHAR(50), finition VARCHAR(100), quantite INT NOT NULL, prix_exa DECIMAL(10, 2) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS devis (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, qty INT NOT NULL, ht DECIMAL(10, 2) NOT NULL, ttc DECIMAL(10, 2) NOT NULL, details JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        // V5 — Moteur de prix : parametres globaux + forfaits vehicule
        await conn.query(`CREATE TABLE IF NOT EXISTS parametres (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, cle VARCHAR(50) NOT NULL, valeur DECIMAL(10, 2) NOT NULL, UNIQUE KEY uniq_user_cle (user_id, cle), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS forfaits (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, prix DECIMAL(10, 2) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);

        // V6 — Moteur unifie : laminations, tapes, colonnes additionnelles
        await ensureV6Tables(conn);
        // V7 — Kits signaletique a prix fixe
        await ensureV7Tables(conn);
        // V8 — Suivi de stock
        await ensureV8Tables(conn);
        // V9 — Nom du client sur les devis
        await ensureV9Tables(conn);
        // V11 — Equipe, clients/prospects, notifications
        await ensureV11Tables(conn);
        // V26 — Photos du vehicule
        await ensureV26Tables(conn);
        // V28 — Zones du vehicule
        await ensureV28Tables(conn);

        const [users] = await conn.query('SELECT COUNT(*) as count FROM users');
        if (users[0].count === 0) {
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await conn.query('INSERT INTO users (email, password, nom, role) VALUES (?, ?, ?, ?)', ['admin@dropstyle.com', hashedPassword, 'Admin DropStyle', 'admin']);
            const [adminUser] = await conn.query('SELECT id FROM users WHERE email = ?', ['admin@dropstyle.com']);
            const adminId = adminUser[0].id;
            
            // Vinyles
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, '3M Scotchprint Standard', 12.50, 'standard']);
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, '3M Scotchprint Premium', 18.00, 'premium']);
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, 'Avery Supreme Wrapping', 14.20, 'premium']);
            
            // Matériaux
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'PVC 380g blanc', 15.00, 'pvc']);
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'Acrylique PMMA 3mm', 22.50, 'acrylique']);
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'DiBond 3mm', 18.75, 'dibond']);
            
            // Poseurs
            await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES (?, ?, ?, ?)', [adminId, 'Jean Pose Pro', 150.00, 85.00]);
            await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES (?, ?, ?, ?)', [adminId, 'Marie Installation', 160.00, 90.00]);
            
            // Impressions (exemples Exaprint)
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Flyer', 'A6', '170g', 'Mat', 500, 25.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Flyer', 'A6', '170g', 'Mat', 1000, 45.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Flyer', 'A6', '170g', 'Brillant', 1000, 48.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Flyer', 'A5', '170g', 'Mat', 500, 35.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Flyer', 'A5', '170g', 'Mat', 1000, 55.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Carte de visite', 'Standard', '300g', 'Mat', 100, 18.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Carte de visite', 'Standard', '300g', 'Mat', 500, 35.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Carte de visite', 'Standard', '350g', 'Pelliculé mat', 500, 45.00]);
            await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [adminId, 'Carte de visite', 'Standard', '350g', 'Soft Touch', 500, 55.00]);

            // V5 — Parametres moteur par defaut
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [adminId, 'coefficient', 2.00]);
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [adminId, 'lamination_m2', 12.00]);
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [adminId, 'pao_forfait', 350.00]);
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [adminId, 'pao_horaire', 60.00]);

            // V5 — Forfaits vehicule (depuis historique)
            await conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Petit semi-covering', 1092.00]);
            await conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Partner Long M (complet)', 3670.00]);

            // V7 — Kits roll-up (prix de vente placeholder — a ajuster dans l'admin)
            await conn.query('INSERT INTO kits_signaletique (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Roll-up 85×200 standard', 89.00]);
            await conn.query('INSERT INTO kits_signaletique (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Roll-up 85×200 premium (housse rigide)', 129.00]);
        }
    } catch (err) {
        console.error('DB Error:', err.message);
    } finally {
        if (conn) await conn.release();
    }
}

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    const jwt = require('jsonwebtoken');
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // V11 — equipe. req.userId designe le PROPRIETAIRE des donnees (le compte principal de
        // l'entreprise) : tous les endpoints existants filtrent deja dessus, ils deviennent donc
        // partages entre collegues sans etre modifies. req.authUserId reste la personne connectee,
        // pour tout ce qui est nominatif (auteur d'un devis, expediteur d'une notification).
        // Jeton emis avant la V11 : equipe_id absent -> on retombe sur son propre id, comportement inchange.
        req.authUserId = decoded.id;
        req.userId = decoded.equipe_id || decoded.id;
        req.userRole = decoded.role;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Token invalide' });
    }
};

// AUTH
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives, réessayez dans 15 minutes' }
});
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, nom } = req.body;
        const bcrypt = require('bcrypt');
        await avecConnexion(async (conn) => {
            const [rows] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
            if (rows.length > 0) return res.status(400).json({ error: 'Email déjà utilisé' });
            // bcrypt echoue si le mot de passe est absent : la connexion doit etre rendue
            // quand meme, sinon dix appels suffisaient a bloquer toute l'application.
            const hashedPassword = await bcrypt.hash(password, 10);
            await conn.query('INSERT INTO users (email, password, nom, role) VALUES (?, ?, ?, ?)', [email, hashedPassword, nom, 'user']);
            res.status(201).json({ message: 'Utilisateur créé' });
        });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const bcrypt = require('bcrypt');
        const jwt = require('jsonwebtoken');
        const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM users WHERE email = ?', [email]));
        if (rows.length === 0) return res.status(401).json({ error: 'Identifiants invalides' });
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
        // V13 — suivi des connexions. Hors du chemin critique : si la colonne n'existe pas
        // encore au premier demarrage, la connexion doit reussir quand meme.
        try {
            await avecConnexion(conn => conn.query('UPDATE users SET derniere_connexion = NOW(), nb_connexions = COALESCE(nb_connexions, 0) + 1 WHERE id = ?', [user.id]));
        } catch (e) { console.error('Suivi connexion :', e.message); }
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role, equipe_id: user.equipe_id || user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, nom: user.nom, role: user.role } });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// VINYLES CRUD
app.get('/api/tarifs/vinyles', verifyToken, async (req, res) => {
    try { const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM vinyles WHERE user_id = ?', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/vinyles', verifyToken, async (req, res) => {
    try { const { name, price, type } = req.body; await avecConnexion(conn => conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [req.userId, name, price, type])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/vinyles/:id', verifyToken, async (req, res) => {
    try { const { name, price, type } = req.body; await avecConnexion(conn => conn.query('UPDATE vinyles SET name = ?, price = ?, type = ? WHERE id = ? AND user_id = ?', [name, price, type, req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/vinyles/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM vinyles WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// MATERIAUX CRUD
app.get('/api/tarifs/materiaux', verifyToken, async (req, res) => {
    try { const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM materiaux WHERE user_id = ?', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/materiaux', verifyToken, async (req, res) => {
    try { const { support, price, categorie } = req.body; await avecConnexion(conn => conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [req.userId, support, price, categorie])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/materiaux/:id', verifyToken, async (req, res) => {
    try { const { support, price, categorie } = req.body; await avecConnexion(conn => conn.query('UPDATE materiaux SET support = ?, price = ?, categorie = ? WHERE id = ? AND user_id = ?', [support, price, categorie, req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/materiaux/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM materiaux WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// POSEURS CRUD
app.get('/api/tarifs/poseurs', verifyToken, async (req, res) => {
    try { const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM poseurs WHERE user_id = ?', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/poseurs', verifyToken, async (req, res) => {
    try { const { nom, jour, demijour, type_prix } = req.body; await avecConnexion(conn => conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour, type_prix) VALUES (?, ?, ?, ?, ?)', [req.userId, nom, jour, demijour, type_prix || 'vente'])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { const { nom, jour, demijour } = req.body; await avecConnexion(conn => conn.query('UPDATE poseurs SET nom = ?, jour = ?, demijour = ?, type_prix = ? WHERE id = ? AND user_id = ?', [nom, jour, demijour, req.body.type_prix || 'vente', req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM poseurs WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPRESSIONS CRUD
app.get('/api/tarifs/impressions', verifyToken, async (req, res) => {
    try { const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM impressions WHERE user_id = ? ORDER BY type, format, grammage, finition, quantite', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/impressions', verifyToken, async (req, res) => {
    try { const { type, format, grammage, finition, quantite, prix_exa } = req.body; await avecConnexion(conn => conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.userId, type, format, grammage, finition, quantite, prix_exa])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/impressions/:id', verifyToken, async (req, res) => {
    try { const { type, format, grammage, finition, quantite, prix_exa } = req.body; await avecConnexion(conn => conn.query('UPDATE impressions SET type = ?, format = ?, grammage = ?, finition = ?, quantite = ?, prix_exa = ? WHERE id = ? AND user_id = ?', [type, format, grammage, finition, quantite, prix_exa, req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/impressions/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM impressions WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// V5 — PARAMETRES MOTEUR (cle/valeur)
// V6 — Parametres complets du moteur (codes P01-P24 du classeur de validation)
const DEFAULT_PARAMS = {
    coefficient: 2.00,           // P01 - multiplicateur du debourse sec matiere (vinyle/lamination/impression, production interne)
    tva: 20.00,                  // P02 - en %
    minimum_commande: 80.00,     // P03 - € HT
    frais_dossier: 40.00,        // P04 - € HT par devis
    arrondi: 5.00,               // P05 - arrondi commercial au multiple superieur
    coef_urgent: 1.15,           // P06
    coef_express: 1.25,          // P07
    remise_qte2: 3.00,           // P08 - en %, matiere uniquement
    remise_qte3: 5.00,           // P09 - en %, matiere uniquement
    chute_vehicule: 1.25,        // P10 - surfaces hors chutes (valide 26/08)
    chute_signaletique: 1.10,    // P11
    lamination_m2: 2.83,         // P12 - prix achat lamination par defaut
    espace_stickers: 6.00,       // P13 - mm
    coef_forme_rond: 1.28,       // P14
    coef_forme_custom: 1.18,     // P15
    pao_forfait: 350.00,         // P16 - vente directe
    pao_horaire: 60.00,          // P17 - vente directe (cale sur les devis reels : 1 h 30 facturee 90 EUR)
    pose_atelier_jour: 525.00,   // P18 - vente directe
    pose_atelier_demi: 300.00,   // P19 - vente directe
    pose_site_point: 300.00,     // P20 - vente directe
    taux_horaire_atelier: 60.00, // P21 - echenillage, decoupe, finitions
    coef_impression: 2.00,       // P22 - marge sur prix Exaprint
    impression_m2: 12.00,        // P23 - cout encre + machine (valide 10-15 €)
    coef_pose_st: 1.30,          // P24 - majoration cout poseur sous-traitant
    seuil_stock_defaut: 2.00,    // seuil d'alerte stock par defaut (m²), hors codes P01-P24 — module stock independant
    marge_plotteur_mm: 50,       // marge technique du plotteur de decoupe (mm, de chaque cote) — plotteur laize 1600 remplace, 1500mm reellement utilisables
    coef_materiaux: 2.00,        // coefficient distinct pour les materiaux panneaux (achat-revente pur) — calibre sur facture reelle DE06433, hors codes P01-P24
    coef_impression_interne: 3.75, // coefficient sur l'impression numerique interne (P23), distinct de P01 (vinyle/lamination) et P22 (Exaprint sous-traite) — calibre sur facture reelle, hors codes P01-P24
    // V24 — habillage saisonnier (cinq fetes). Purement visuel : aucune de ces quatre
    // valeurs n'entre dans un calcul de prix. Elles sont reglables depuis l'admin.
    theme_mode: 1,               // 0 jamais · 1 automatique selon la date · 2 forcer une fete
    theme_force: 0,              // fete forcee : 0 Halloween · 1 Noel · 2 Jour de l'an · 3 Saint-Valentin · 4 Paques
    theme_intensite: 1,          // 0 discret · 1 normal · 2 fete
    theme_anim: 2                // a l'enregistrement : 0 aucune · 1 clin d'oeil · 2 pluie · 3 grande apparition · 4 eclat
};
app.get('/api/parametres', verifyToken, async (req, res) => {
    try {
        const rows = await avecConnexion(async (conn) => {
            let [lignes] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
            const have = new Set(lignes.map(r => r.cle));
            let added = false;
            for (const [cle, valeur] of Object.entries(DEFAULT_PARAMS)) {
                if (!have.has(cle)) { await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [req.userId, cle, valeur]); added = true; }
            }
            if (added) [lignes] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
            return lignes;
        });
        const obj = {};
        rows.forEach(r => { obj[r.cle] = parseFloat(r.valeur); });
        res.json(obj);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/parametres', verifyToken, async (req, res) => {
    try {
        const updates = req.body || {};
        await avecConnexion(async (conn) => {
            for (const [cle, valeur] of Object.entries(updates)) {
                await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valeur = ?', [req.userId, cle, valeur, valeur]);
            }
        });
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// V5 — FORFAITS VEHICULE CRUD
app.get('/api/tarifs/forfaits', verifyToken, async (req, res) => {
    try { const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM forfaits WHERE user_id = ? ORDER BY prix', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/forfaits', verifyToken, async (req, res) => {
    try { const { nom, prix } = req.body; await avecConnexion(conn => conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [req.userId, nom, prix])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/forfaits/:id', verifyToken, async (req, res) => {
    try { const { nom, prix } = req.body; await avecConnexion(conn => conn.query('UPDATE forfaits SET nom = ?, prix = ? WHERE id = ? AND user_id = ?', [nom, prix, req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/forfaits/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM forfaits WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// V7 — KITS ROLL-UP (signaletique) CRUD
app.get('/api/tarifs/kits-signaletique', verifyToken, async (req, res) => {
    try { await ensureV7Tables(); const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM kits_signaletique WHERE user_id = ? ORDER BY prix', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/kits-signaletique', verifyToken, async (req, res) => {
    try { await ensureV7Tables(); const { nom, prix } = req.body; await avecConnexion(conn => conn.query('INSERT INTO kits_signaletique (user_id, nom, prix) VALUES (?, ?, ?)', [req.userId, nom, prix])); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/kits-signaletique/:id', verifyToken, async (req, res) => {
    try { const { nom, prix } = req.body; await avecConnexion(conn => conn.query('UPDATE kits_signaletique SET nom = ?, prix = ? WHERE id = ? AND user_id = ?', [nom, prix, req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/kits-signaletique/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM kits_signaletique WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// DEVIS
// ===== V6 — LAMINATIONS & TAPES =====
app.get('/api/tarifs/laminations', verifyToken, async (req, res) => {
    try { await ensureV6Tables(); const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM laminations WHERE user_id = ? ORDER BY prix', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/tarifs/tapes', verifyToken, async (req, res) => {
    try { await ensureV6Tables(); const [rows] = await avecConnexion(conn => conn.query('SELECT * FROM tapes WHERE user_id = ? ORDER BY prix', [req.userId])); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V6 — SYNCHRONISATION GOOGLE SHEETS =====
const SHEETS_ID = process.env.SHEETS_ID || '1SzqEGSVwO8PTJSYpt7XGQ0NsibgmBhUcSH0mCmn2rwQ';
const https = require('https');

function httpGet(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) { r.resume(); return resolve(httpGet(r.headers.location, redirects - 1)); }
            if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
            let d = ''; r.setEncoding('utf8');
            r.on('data', c => d += c);
            r.on('end', () => resolve(d));
        }).on('error', reject);
    });
}

function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
            else cell += ch;
        } else {
            if (ch === '"') q = true;
            else if (ch === ',') { row.push(cell); cell = ''; }
            else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
            else if (ch !== '\r') cell += ch;
        }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

function cleanNum(v) {
    if (v === undefined || v === null) return null;
    let s = String(v).trim();
    if (!s) return null;
    s = s.replace(/[€%\s\u00A0"]/g, '');
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}

const SHEET_PARAM_MAP = {
    P01: 'coefficient', P02: 'tva', P03: 'minimum_commande', P04: 'frais_dossier', P05: 'arrondi',
    P06: 'coef_urgent', P07: 'coef_express', P08: 'remise_qte2', P09: 'remise_qte3',
    P10: 'chute_vehicule', P11: 'chute_signaletique', P12: 'lamination_m2', P13: 'espace_stickers',
    P14: 'coef_forme_rond', P15: 'coef_forme_custom', P16: 'pao_forfait', P17: 'pao_horaire',
    P18: 'pose_atelier_jour', P19: 'pose_atelier_demi', P20: 'pose_site_point', P21: 'taux_horaire_atelier',
    P22: 'coef_impression', P23: 'impression_m2', P24: 'coef_pose_st'
};

async function fetchSheetsData() {
    const base = `https://docs.google.com/spreadsheets/d/${SHEETS_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=`;
    const [csvParams, csvTarifs] = await Promise.all([
        httpGet(base + encodeURIComponent('Paramètres')),
        httpGet(base + encodeURIComponent('Tarifs matières'))
    ]);
    if (csvParams.trimStart().startsWith('<')) throw new Error('ACCES');
    // Parametres : ligne dont la colonne A = P01..P24. Les colonnes sont reperees via la
    // ligne d'en-tetes (retenue / validee / proposee) pour tolerer une restructuration du Sheets.
    const parametres = {};
    let colRetenue = -1, colValidee = -1, colProposee = -1;
    for (const row of parseCSV(csvParams)) {
        const code = (row[0] || '').trim();
        const lower = row.map(c => String(c || '').toLowerCase());
        if (colRetenue < 0 && lower.some(c => c.includes('param'))) {
            colRetenue = lower.findIndex(c => c.includes('retenue'));
            colValidee = lower.findIndex(c => c.includes('valid'));
            colProposee = lower.findIndex(c => c.includes('propos'));
        }
        if (/^P\d{2}$/.test(code) && SHEET_PARAM_MAP[code]) {
            let val = null;
            if (colRetenue >= 0) val = cleanNum(row[colRetenue]);
            if (val === null && colValidee >= 0) val = cleanNum(row[colValidee]);
            if (val === null && colProposee >= 0) val = cleanNum(row[colProposee]);
            if (val === null) val = cleanNum(row[4]) ?? cleanNum(row[3]) ?? cleanNum(row[2]);
            if (val !== null) parametres[SHEET_PARAM_MAP[code]] = val;
        }
    }
    // Tarifs : sections VINYLES / LAMINATIONS / TAPES / MATERIAUX PANNEAUX.
    // La ligne d'en-tetes de chaque section indique ou sont les colonnes prix / valide / laizes,
    // pour tolerer toute restructuration du Sheets par l'entreprise.
    const tables = { vinyles: [], laminations: [], tapes: [], materiaux: [] };
    let current = null, pendingHeader = false;
    let colPrix = 1, colValide = -1, colLaizes = 3;
    for (const row of parseCSV(csvTarifs)) {
        const a = (row[0] || '').trim();
        const aU = a.toUpperCase();
        if (aU.startsWith('VINYLES')) { current = 'vinyles'; pendingHeader = true; continue; }
        if (aU.startsWith('LAMINATIONS')) { current = 'laminations'; pendingHeader = true; continue; }
        if (aU.startsWith('TAPES')) { current = 'tapes'; pendingHeader = true; continue; }
        if (aU.startsWith('MATÉRIAUX') || aU.startsWith('MATERIAUX')) { current = 'materiaux'; pendingHeader = true; continue; }
        if (aU.startsWith('QUESTION') || aU.startsWith('IMPORTANT')) { current = null; continue; }
        if (!current || !a) continue;
        if (pendingHeader) {
            // ligne d'en-tetes de la section : reperer les colonnes
            const lower = row.map(c => String(c || '').toLowerCase());
            const iPrix = lower.findIndex(c => c.includes('prix') && !c.includes('valid'));
            const iValide = lower.findIndex(c => c.includes('valid'));
            const iLaizes = lower.findIndex(c => c.includes('laize') || c.includes('format'));
            pendingHeader = false;
            if (iPrix >= 0 || iLaizes >= 0) {
                colPrix = iPrix >= 0 ? iPrix : 1;
                colValide = iValide;
                colLaizes = iLaizes >= 0 ? iLaizes : 2;
                continue;
            }
            // pas une ligne d'en-tetes (elle a ete supprimee ?) : colonnes par defaut, et la ligne est traitee comme une donnee
            colPrix = 1; colValide = -1; colLaizes = 2;
        }
        if (a.startsWith('(')) continue;
        let prix = null;
        if (colValide >= 0) prix = cleanNum(row[colValide]);
        if (prix === null) prix = cleanNum(row[colPrix]);
        if (prix === null) continue;
        tables[current].push({ nom: a, prix, laizes: (row[colLaizes] || '').trim() });
    }
    return { parametres, tables };
}

app.get('/api/sync-sheets/preview', verifyToken, async (req, res) => {
    try {
        await ensureV6Tables();
        const data = await fetchSheetsData();
        const { rows, vin, lam, tap, mat } = await avecConnexion(async (conn) => {
            const [rows] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
            const [vin] = await conn.query('SELECT COUNT(*) AS n FROM vinyles WHERE user_id = ?', [req.userId]);
            const [lam] = await conn.query('SELECT COUNT(*) AS n FROM laminations WHERE user_id = ?', [req.userId]);
            const [tap] = await conn.query('SELECT COUNT(*) AS n FROM tapes WHERE user_id = ?', [req.userId]);
            const [mat] = await conn.query('SELECT COUNT(*) AS n FROM materiaux WHERE user_id = ?', [req.userId]);
            return { rows, vin, lam, tap, mat };
        });
        const actuels = {};
        rows.forEach(r => actuels[r.cle] = parseFloat(r.valeur));
        const diffParams = [];
        for (const [cle, apres] of Object.entries(data.parametres)) {
            const avant = actuels[cle] ?? DEFAULT_PARAMS[cle] ?? null;
            if (avant === null || Math.abs(avant - apres) > 0.0001) diffParams.push({ cle, avant, apres });
        }
        res.json({
            parametres: diffParams,
            tables: {
                vinyles: { avant: vin[0].n, apres: data.tables.vinyles.length, items: data.tables.vinyles.map(x => x.nom) },
                laminations: { avant: lam[0].n, apres: data.tables.laminations.length, items: data.tables.laminations.map(x => x.nom) },
                tapes: { avant: tap[0].n, apres: data.tables.tapes.length, items: data.tables.tapes.map(x => x.nom) },
                materiaux: { avant: mat[0].n, apres: data.tables.materiaux.length, items: data.tables.materiaux.map(x => x.nom) }
            }
        });
    } catch (err) {
        if (err.message === 'ACCES' || /^HTTP (401|403|404)/.test(err.message)) return res.status(502).json({ error: 'Accès refusé au Google Sheets — vérifier le partage : « Toute personne disposant du lien : Lecteur ».' });
        res.status(500).json({ error: 'Synchronisation impossible : ' + err.message });
    }
});

app.post('/api/sync-sheets/apply', verifyToken, async (req, res) => {
    try {
        await ensureV6Tables();
        const data = await fetchSheetsData();
        await avecConnexion(async (conn) => {
            for (const [cle, valeur] of Object.entries(data.parametres)) {
                await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valeur = ?', [req.userId, cle, valeur, valeur]);
            }
            if (data.tables.vinyles.length) {
                await conn.query('DELETE FROM vinyles WHERE user_id = ?', [req.userId]);
                for (const v of data.tables.vinyles) await conn.query('INSERT INTO vinyles (user_id, name, price, type, laizes) VALUES (?, ?, ?, ?, ?)', [req.userId, v.nom, v.prix, 'sheets', v.laizes]);
            }
            if (data.tables.laminations.length) {
                await conn.query('DELETE FROM laminations WHERE user_id = ?', [req.userId]);
                for (const v of data.tables.laminations) await conn.query('INSERT INTO laminations (user_id, nom, prix, laizes) VALUES (?, ?, ?, ?)', [req.userId, v.nom, v.prix, v.laizes]);
            }
            if (data.tables.tapes.length) {
                await conn.query('DELETE FROM tapes WHERE user_id = ?', [req.userId]);
                for (const v of data.tables.tapes) await conn.query('INSERT INTO tapes (user_id, nom, prix, laizes) VALUES (?, ?, ?, ?)', [req.userId, v.nom, v.prix, v.laizes]);
            }
            if (data.tables.materiaux.length) {
                await conn.query('DELETE FROM materiaux WHERE user_id = ?', [req.userId]);
                for (const v of data.tables.materiaux) await conn.query('INSERT INTO materiaux (user_id, support, price, categorie, format_plaque) VALUES (?, ?, ?, ?, ?)', [req.userId, v.nom, v.prix, 'panneau', v.laizes]);
            }
        });
        res.json({ message: 'Synchronisation appliquée', parametres: Object.keys(data.parametres).length, vinyles: data.tables.vinyles.length, laminations: data.tables.laminations.length, tapes: data.tables.tapes.length, materiaux: data.tables.materiaux.length });
    } catch (err) {
        if (err.message === 'ACCES' || /^HTTP (401|403|404)/.test(err.message)) return res.status(502).json({ error: 'Accès refusé au Google Sheets — vérifier le partage : « Toute personne disposant du lien : Lecteur ».' });
        res.status(500).json({ error: 'Synchronisation impossible : ' + err.message });
    }
});

app.post('/api/devis', verifyToken, async (req, res) => {
    try {
        await ensureV9Tables(); await ensureV11Tables();
        const { type, qty, ht, ttc, details, client, client_id, ht_calcule, ajustement_pct, brouillon_id, saisie } = req.body;
        const devisId = await avecConnexion(async (conn) => {
            // client_id n'est accepte que s'il appartient a l'equipe, sinon on l'ignore et
            // on garde le nom en texte : un devis mal rattache fausserait les statistiques.
            let lien = null;
            if (client_id) {
                const [c] = await conn.query('SELECT id FROM clients WHERE id = ? AND equipe_id = ?', [client_id, req.userId]);
                if (c.length) lien = c[0].id;
            }
            const colSaisie = devisPorteLaSaisie ? 'saisie, ' : '';
            const valSaisie = devisPorteLaSaisie ? '?, ' : '';
            const argSaisie = devisPorteLaSaisie ? [saisie ? JSON.stringify(saisie) : null] : [];
            const [r] = await conn.query(
                `INSERT INTO devis (user_id, type, qty, ht, ttc, details, ${colSaisie}client, client_id, auteur_id, ht_calcule, ajustement_pct, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ${valSaisie}?, ?, ?, ?, ?, NOW())`,
                [req.userId, type, qty, ht, ttc, JSON.stringify(details), ...argSaisie,
                 (client || '').trim() || null, lien, req.authUserId,
                 ht_calcule === undefined || ht_calcule === null ? null : ht_calcule,
                 ajustement_pct === undefined || ajustement_pct === null ? null : ajustement_pct]);
            return r.insertId;
        });
        // V26 — rattachement des photos prises pendant le chiffrage. Volontairement hors du
        // chemin critique : le devis est deja enregistre, et un echec ici ne doit surtout pas
        // renvoyer une erreur, sinon l'utilisateur reessaie et cree un doublon.
        let photos = 0;
        if (/^[a-z0-9-]{8,40}$/i.test(String(brouillon_id || ''))) {
            try {
                await ensureV26Tables();
                const [r] = await avecConnexion(conn => conn.query(
                    'UPDATE devis_photos SET devis_id = ?, brouillon_id = NULL WHERE equipe_id = ? AND brouillon_id = ? AND devis_id IS NULL',
                    [devisId, req.userId, brouillon_id]));
                photos = r.affectedRows;
            } catch (e) { console.error('Rattachement photos :', e.message); }
        }
        res.status(201).json({ message: 'OK', id: devisId, photos });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// V33 — modification d'un devis deja enregistre. Le devis garde son id, sa date de
// creation et son statut : on remplace ce qui a ete recalcule, rien d'autre. Le client
// peut changer, parce qu'un devis attribue au mauvais client fausse les statistiques.
app.put('/api/devis/:id', verifyToken, async (req, res) => {
    try {
        await ensureV9Tables(); await ensureV11Tables();
        const { type, qty, ht, ttc, details, saisie, client, client_id, ht_calcule, ajustement_pct } = req.body;
        if (!type || !(Number(ht) >= 0)) return res.status(400).json({ error: 'Devis incomplet' });
        const touche = await avecConnexion(async (conn) => {
            let lien = null;
            if (client_id) {
                const [c] = await conn.query('SELECT id FROM clients WHERE id = ? AND equipe_id = ?', [client_id, req.userId]);
                if (c.length) lien = c[0].id;
            }
            const majSaisie = devisPorteLaSaisie ? 'saisie = ?, ' : '';
            const argSaisie = devisPorteLaSaisie ? [saisie ? JSON.stringify(saisie) : null] : [];
            const [r] = await conn.query(
                `UPDATE devis SET type = ?, qty = ?, ht = ?, ttc = ?, details = ?, ${majSaisie}
                        client = ?, client_id = ?, ht_calcule = ?, ajustement_pct = ?, modifie_le = NOW(), modifie_par = ?
                 WHERE id = ? AND user_id = ?`,
                [type, qty, ht, ttc, JSON.stringify(details), ...argSaisie,
                 (client || '').trim() || null, lien,
                 ht_calcule === undefined || ht_calcule === null ? null : ht_calcule,
                 ajustement_pct === undefined || ajustement_pct === null ? null : ajustement_pct,
                 req.authUserId, req.params.id, req.userId]);
            return r.affectedRows;
        });
        if (!touche) return res.status(404).json({ error: 'Devis introuvable' });
        // Volontairement hors du chemin critique, comme a la creation : le devis est deja
        // enregistre, et un echec ici ne doit pas faire croire a une mise a jour ratee.
        let photos = 0;
        if (/^[a-z0-9-]{8,40}$/i.test(String(req.body.brouillon_id || ''))) {
            try {
                await ensureV26Tables();
                const [r] = await avecConnexion(conn => conn.query(
                    'UPDATE devis_photos SET devis_id = ?, brouillon_id = NULL WHERE equipe_id = ? AND brouillon_id = ? AND devis_id IS NULL',
                    [req.params.id, req.userId, req.body.brouillon_id]));
                photos = r.affectedRows;
            } catch (e) { console.error('Rattachement photos (maj) :', e.message); }
        }
        res.json({ message: 'OK', id: Number(req.params.id), photos });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/devis', verifyToken, async (req, res) => {
    try {
        await ensureV9Tables(); await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            `SELECT d.*, u.nom AS auteur_nom FROM devis d LEFT JOIN users u ON u.id = d.auteur_id
             WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT 50`, [req.userId]));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// V14 — statut d'un devis. 'calcule' = prix etabli, sans reponse du client ; 'valide' =
// commande obtenue ; 'refuse' = affaire perdue. La distinction entre 'calcule' et 'refuse'
// est ce qui permet de calculer un vrai taux de transformation.
const STATUTS_DEVIS = ['calcule', 'valide', 'refuse'];

// ===== V38 — NOTIFICATIONS SYSTEME (WEB PUSH) =====
// Sans cles VAPID, le push est simplement indisponible : le reste du logiciel, lui,
// continue de fonctionner, et les notifications restent visibles dans la cloche.
const webpush = require('web-push');
const PUSH_PUBLIQUE = process.env.VAPID_PUBLIC || '';
const PUSH_PRIVEE = process.env.VAPID_PRIVATE || '';
const PUSH_SUJET = process.env.VAPID_SUJET || 'mailto:contact@dropstyle.fr';
let pushPret = false;
try {
    if (PUSH_PUBLIQUE && PUSH_PRIVEE) {
        webpush.setVapidDetails(PUSH_SUJET, PUSH_PUBLIQUE, PUSH_PRIVEE);
        pushPret = true;
    } else {
        console.warn('V38 : VAPID_PUBLIC / VAPID_PRIVATE absents — notifications systeme desactivees.');
    }
} catch (e) { console.error('V38 config push :', e.message); }

// La cle publique sert au navigateur pour s'abonner ; elle n'a rien de secret.
app.get('/api/push/cle', verifyToken, (req, res) => {
    res.json({ disponible: pushPret, cle: pushPret ? PUSH_PUBLIQUE : null });
});

app.post('/api/push/abonnement', verifyToken, async (req, res) => {
    try {
        const { endpoint, keys } = req.body || {};
        if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Abonnement incomplet' });
        await ensureV11Tables();
        await avecConnexion(conn => conn.query(
            `INSERT INTO push_abonnements (user_id, equipe_id, endpoint, p256dh, auth, agent)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), equipe_id = VALUES(equipe_id),
                                     p256dh = VALUES(p256dh), auth = VALUES(auth), agent = VALUES(agent)`,
            [req.authUserId, req.userId, String(endpoint).slice(0, 500), keys.p256dh, keys.auth,
             String(req.headers['user-agent'] || '').slice(0, 255)]));
        res.status(201).json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/push/abonnement', verifyToken, async (req, res) => {
    try {
        const endpoint = String((req.body && req.body.endpoint) || '');
        if (!endpoint) return res.status(400).json({ error: 'Endpoint requis' });
        await avecConnexion(conn => conn.query(
            'DELETE FROM push_abonnements WHERE endpoint = ? AND user_id = ?', [endpoint.slice(0, 500), req.authUserId]));
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Envoi a tous les appareils d'un utilisateur. Un abonnement expire (404/410) est
// supprime : le garder ferait echouer tous les envois suivants pour rien.
async function envoyerPush(userId, charge) {
    if (!pushPret) return 0;
    let envoyes = 0;
    try {
        const [abos] = await avecConnexion(conn => conn.query(
            'SELECT id, endpoint, p256dh, auth FROM push_abonnements WHERE user_id = ?', [userId]));
        const morts = [];
        await Promise.all(abos.map(async (a) => {
            try {
                await webpush.sendNotification(
                    { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
                    JSON.stringify(charge));
                envoyes++;
            } catch (e) {
                if (e && (e.statusCode === 404 || e.statusCode === 410)) morts.push(a.id);
                else console.error('V38 envoi push :', e && e.message);
            }
        }));
        if (morts.length) {
            await avecConnexion(conn => conn.query(
                'DELETE FROM push_abonnements WHERE id IN (' + morts.map(() => '?').join(',') + ')', morts));
        }
    } catch (e) { console.error('V38 push :', e.message); }
    return envoyes;
}

app.put('/api/devis/:id/statut', verifyToken, async (req, res) => {
    try {
        // Verifie avant d'ouvrir une connexion : inutile de solliciter la base pour
        // rejeter une valeur invalide.
        const statut = String(req.body.statut || '');
        if (!STATUTS_DEVIS.includes(statut)) return res.status(400).json({ error: 'Statut inconnu' });
        await ensureV11Tables();
        const [r] = await avecConnexion(conn => conn.query(
            'UPDATE devis SET statut = ?, statut_le = NOW(), statut_par = ? WHERE id = ? AND user_id = ?',
            [statut, req.authUserId, req.params.id, req.userId]));
        if (!r.affectedRows) return res.status(404).json({ error: 'Devis introuvable' });
        res.json({ message: 'OK', statut });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/devis/:id', verifyToken, async (req, res) => {
    try { await avecConnexion(conn => conn.query('DELETE FROM devis WHERE id = ? AND user_id = ?', [req.params.id, req.userId])); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V26 — PHOTOS DU VEHICULE =====
// Une photo par face et par brouillon : reprendre une face remplace la precedente, pour
// qu'une photo ratee ne laisse pas deux versions en base.
app.post('/api/photos', verifyToken, async (req, res) => {
    try {
        const face = String(req.body.face || '');
        if (!FACES_ACCEPTEES.includes(face)) return res.status(400).json({ error: 'Face inconnue' });
        const brouillon = String(req.body.brouillon_id || '');
        if (!/^[a-z0-9-]{8,40}$/i.test(brouillon)) return res.status(400).json({ error: 'Identifiant de brouillon invalide' });
        // Le navigateur envoie une data-URL ; on n'accepte que des images, et on verifie le
        // poids sur les octets decodes, seule mesure fiable.
        const m = String(req.body.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return res.status(400).json({ error: 'Image attendue en JPEG, PNG ou WebP' });
        const octets = Buffer.from(m[2], 'base64');
        if (!octets.length) return res.status(400).json({ error: 'Image vide' });
        if (octets.length > POIDS_MAX_PHOTO) {
            return res.status(413).json({ error: `Photo trop lourde (${Math.round(octets.length / 1024)} ko pour un maximum de ${Math.round(POIDS_MAX_PHOTO / 1024)} ko)` });
        }
        await ensureV26Tables();
        const id = await avecConnexion(async (conn) => {
            // Menage des brouillons abandonnes, limite a l'equipe appelante : on ne touche
            // jamais aux donnees d'une autre entreprise, meme pour faire le menage.
            await conn.query(
                'DELETE FROM devis_photos WHERE equipe_id = ? AND devis_id IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
                [req.userId, JOURS_BROUILLON]);
            await conn.query(
                'DELETE FROM devis_photos WHERE equipe_id = ? AND brouillon_id = ? AND face = ? AND devis_id IS NULL',
                [req.userId, brouillon, face]);
            const [r] = await conn.query(
                `INSERT INTO devis_photos (equipe_id, brouillon_id, face, mime, octets, largeur, hauteur, poids, auteur_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.userId, brouillon, face, m[1], octets,
                 parseInt(req.body.largeur, 10) || null, parseInt(req.body.hauteur, 10) || null,
                 octets.length, req.authUserId]);
            return r.insertId;
        });
        res.status(201).json({ id, face, poids: octets.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Liste les photos d'un brouillon ou d'un devis — sans les octets, qui se recuperent une
// par une : renvoyer cinq images dans un meme JSON alourdirait chaque ouverture de devis.
app.get('/api/photos', verifyToken, async (req, res) => {
    try {
        await ensureV26Tables();
        const brouillon = String(req.query.brouillon_id || '');
        const devisId = parseInt(req.query.devis_id, 10);
        let rows = [];
        if (devisId) {
            [rows] = await avecConnexion(conn => conn.query(
                'SELECT id, face, largeur, hauteur, poids, created_at FROM devis_photos WHERE equipe_id = ? AND devis_id = ? ORDER BY id',
                [req.userId, devisId]));
        } else if (/^[a-z0-9-]{8,40}$/i.test(brouillon)) {
            [rows] = await avecConnexion(conn => conn.query(
                'SELECT id, face, largeur, hauteur, poids, created_at FROM devis_photos WHERE equipe_id = ? AND brouillon_id = ? AND devis_id IS NULL ORDER BY id',
                [req.userId, brouillon]));
        } else {
            return res.status(400).json({ error: 'Préciser brouillon_id ou devis_id' });
        }
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Les octets d'une photo. Le jeton passe par l'en-tete Authorization, donc le navigateur
// ne peut pas pointer un <img src> ici directement : il la recupere en fetch puis en fait
// une URL locale. Mettre le jeton dans l'URL le ferait fuiter dans les journaux.
app.get('/api/photos/:id/image', verifyToken, async (req, res) => {
    try {
        await ensureV26Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            'SELECT mime, octets FROM devis_photos WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]));
        if (!rows.length) return res.status(404).json({ error: 'Photo introuvable' });
        res.set('Content-Type', rows[0].mime);
        res.set('Cache-Control', 'private, max-age=86400');
        res.send(rows[0].octets);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/photos/:id', verifyToken, async (req, res) => {
    try {
        await ensureV26Tables();
        const [r] = await avecConnexion(conn => conn.query(
            'DELETE FROM devis_photos WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]));
        if (!r.affectedRows) return res.status(404).json({ error: 'Photo introuvable' });
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V28 — ZONES DU VEHICULE =====
app.get('/api/zones-vehicule', verifyToken, async (req, res) => {
    try {
        await ensureV28Tables();
        if (v28Echec) return res.status(500).json({ error: 'Table des zones indisponible : ' + v28Echec });
        const rows = await avecConnexion(async (conn) => {
            await ensureZonesEquipe(conn, req.userId);
            const [lignes] = await conn.query(
                `SELECT type_vehicule, cle, nom, face, par_cote, surface_m2, ordre
                 FROM zones_vehicule WHERE equipe_id = ? ORDER BY type_vehicule, ordre`, [req.userId]);
            return lignes;
        });
        const parType = {};
        for (const r of rows) {
            (parType[r.type_vehicule] = parType[r.type_vehicule] || []).push({
                cle: r.cle, nom: r.nom, face: r.face, par_cote: !!r.par_cote, surface_m2: Number(r.surface_m2)
            });
        }
        // Le total accompagne chaque type : c'est lui qui doit rester cale sur la grille
        // validee, et l'admin doit pouvoir le voir pendant qu'il ajuste une surface.
        const totaux = {};
        for (const [t, zones] of Object.entries(parType)) totaux[t] = Math.round(surfaceTotaleZones(zones) * 100) / 100;
        res.json({ zones: parType, totaux });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/zones-vehicule', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const zones = Array.isArray(req.body.zones) ? req.body.zones : [];
        if (!zones.length) return res.status(400).json({ error: 'Aucune zone à enregistrer' });
        // Verifie avant d'ecrire : une surface negative ou absurde fausserait tous les devis
        // du type concerne, sans rien signaler a l'ecran.
        for (const z of zones) {
            const m2 = Number(z.surface_m2);
            if (!isFinite(m2) || m2 < 0 || m2 > 200) {
                return res.status(400).json({ error: `Surface invalide pour « ${String(z.cle || '?').slice(0, 40)} » : attendu entre 0 et 200 m²` });
            }
        }
        await ensureV28Tables();
        const maj = await avecConnexion(async (conn) => {
            await ensureZonesEquipe(conn, req.userId);
            let n = 0;
            for (const z of zones) {
                const [r] = await conn.query(
                    'UPDATE zones_vehicule SET surface_m2 = ? WHERE equipe_id = ? AND type_vehicule = ? AND cle = ?',
                    [Number(z.surface_m2), req.userId, String(z.type_vehicule || ''), String(z.cle || '')]);
                n += r.affectedRows;
            }
            return n;
        });
        res.json({ message: 'OK', zones: maj });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V10 — ASSISTANT (Claude) =====
// Deux usages : chiffrer a partir d'une phrase, et repondre sur les devis enregistres.
// L'IA ne calcule JAMAIS de prix : elle remplit le formulaire, c'est computeTotal() cote
// navigateur qui chiffre avec les coefficients calibres. La cle API reste cote serveur.
const Anthropic = require('@anthropic-ai/sdk');

// Schema strict : l'IA ne peut renvoyer que des champs que le frontend sait appliquer.
const OUTIL_DEVIS = {
    name: 'remplir_devis',
    description: "Remplit le formulaire de devis a partir de la demande. N'utiliser QUE si l'utilisateur decrit un travail a chiffrer. Ne pas utiliser pour une question sur les devis passes.",
    strict: true,
    input_schema: {
        type: 'object',
        properties: {
            onglet: { type: 'string', enum: ['vehicule', 'signaletique', 'stickers'], description: 'Calculateur a utiliser' },
            type_support: { type: ['string', 'null'], enum: ['panneau', 'bache', 'vitrophanie', 'adhesif', 'lettrage', 'rollup', null], description: 'Signaletique uniquement' },
            type_vehicule: { type: ['string', 'null'], enum: ['citadine', 'berline', 'suv', 'utilitaire', 'fourgon', 'camion', null] },
            type_marquage: { type: ['string', 'null'], enum: ['total', 'partiel', 'bandes', 'logos', 'custome', null] },
            lignes: {
                type: ['array', 'null'],
                description: 'Une entree par format demande (signaletique et stickers). Dimensions en millimetres.',
                items: {
                    type: 'object',
                    properties: {
                        largeur_mm: { type: 'number' },
                        hauteur_mm: { type: 'number' },
                        quantite: { type: 'integer' },
                        materiau_id: { type: ['integer', 'null'], description: 'Id du materiau panneau, uniquement pour type_support panneau ou bache' }
                    },
                    required: ['largeur_mm', 'hauteur_mm', 'quantite', 'materiau_id'],
                    additionalProperties: false
                }
            },
            vinyle_id: { type: ['integer', 'null'] },
            lamination_id: { type: ['integer', 'null'], description: 'null = sans lamination' },
            kit_id: { type: ['integer', 'null'], description: 'Roll-up uniquement' },
            quantite_kit: { type: ['integer', 'null'], description: 'Roll-up uniquement' },
            imprime: { type: ['boolean', 'null'], description: 'Visuel imprime (vrai par defaut sauf mention contraire)' },
            pose_points: { type: ['integer', 'null'], description: 'Nombre de points de pose sur site, 0 si sans pose' },
            pao: { type: ['boolean', 'null'] },
            delai: { type: ['string', 'null'], enum: ['normal', 'urgent', 'express', null] },
            manque: { type: 'string', description: "Ce qui manque ou a ete suppose, en une phrase. Chaine vide si tout etait precise." }
        },
        required: ['onglet', 'type_support', 'type_vehicule', 'type_marquage', 'lignes', 'vinyle_id', 'lamination_id', 'kit_id', 'quantite_kit', 'imprime', 'pose_points', 'pao', 'delai', 'manque'],
        additionalProperties: false
    }
};

async function contexteAssistant(userId) {
    return avecConnexion(async (conn) => {
        const [vinyles] = await conn.query('SELECT id, name, price FROM vinyles WHERE user_id = ?', [userId]);
        const [materiaux] = await conn.query('SELECT id, support, price, format_plaque FROM materiaux WHERE user_id = ?', [userId]);
        const [laminations] = await conn.query('SELECT id, nom, prix FROM laminations WHERE user_id = ?', [userId]);
        const [kits] = await conn.query('SELECT id, nom, prix FROM kits_signaletique WHERE user_id = ?', [userId]);
        const [devis] = await conn.query('SELECT id, client, type, qty, ht, ttc, created_at FROM devis WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId]);
        return { vinyles, materiaux, laminations, kits, devis };
    });
}

app.post('/api/chat', verifyToken, async (req, res) => {
    // Le SDK Anthropic a besoin de fetch, absent avant Node 18. Sans ce controle,
    // l'utilisateur recoit un message sur des polyfills, incomprehensible pour lui.
    if (typeof fetch !== 'function') {
        return res.status(503).json({ error: "Serveur sur une version de Node trop ancienne (fetch absent) : cette fonction a besoin de Node 18 ou plus." });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: "Assistant non configuré : la clé ANTHROPIC_API_KEY n'est pas définie sur le serveur." });
    }
    try {
        const { message, historique } = req.body;
        if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message vide' });

        const ctx = await contexteAssistant(req.userId);
        const client = new Anthropic();

        const system = `Tu es l'assistant de DropStyle, une entreprise de signalétique et de covering de véhicules. Tu aides à préparer des devis et à retrouver des informations sur les devis déjà enregistrés.

RÈGLE ABSOLUE : tu ne calcules JAMAIS de prix toi-même et tu n'en inventes jamais. Le moteur de prix de l'application est calibré sur les factures réelles de l'entreprise. Ton rôle est de remplir le formulaire (outil remplir_devis) ; l'application fait le calcul.

Deux cas :
1. L'utilisateur décrit un travail à chiffrer → appelle l'outil remplir_devis. Choisis les identifiants dans le catalogue ci-dessous. Si une information manque, prends l'option la plus courante et signale-le dans le champ "manque".
2. L'utilisateur pose une question (sur ses devis passés, sur le catalogue, sur le fonctionnement) → réponds directement en texte, sans appeler l'outil.

Conventions : dimensions en millimètres. Les visuels sont imprimés par défaut. Réponds toujours en français, brièvement.

CATALOGUE VINYLES (id | nom | prix achat €/m²) :
${ctx.vinyles.map(v => `${v.id} | ${v.name} | ${v.price}`).join('\n') || '(aucun)'}

CATALOGUE MATÉRIAUX PANNEAUX (id | nom | prix achat €/m² | formats de plaque) :
${ctx.materiaux.map(m => `${m.id} | ${m.support} | ${m.price} | ${m.format_plaque || '-'}`).join('\n') || '(aucun)'}

LAMINATIONS (id | nom | prix achat €/m²) :
${ctx.laminations.map(l => `${l.id} | ${l.nom} | ${l.prix}`).join('\n') || '(aucune)'}

KITS ROLL-UP (id | nom | prix de vente €) :
${ctx.kits.map(k => `${k.id} | ${k.nom} | ${k.prix}`).join('\n') || '(aucun)'}

DEVIS ENREGISTRÉS (id | client | type | qté | HT | TTC | date) :
${ctx.devis.map(d => `${d.id} | ${d.client || 'sans nom'} | ${d.type} | ${d.qty} | ${d.ht} | ${d.ttc} | ${new Date(d.created_at).toLocaleDateString('fr-FR')}`).join('\n') || '(aucun devis enregistré)'}`;

        const messages = [
            ...(Array.isArray(historique) ? historique.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : []),
            { role: 'user', content: String(message) }
        ];

        const reponse = await client.messages.create({
            model: 'claude-opus-5',
            max_tokens: 4000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' }, // extraction + Q&A : pas besoin de l'effort maximal
            system,
            tools: [OUTIL_DEVIS],
            messages
        });

        const texte = reponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        const appelOutil = reponse.content.find(b => b.type === 'tool_use');

        res.json({
            reponse: texte,
            devis: appelOutil ? appelOutil.input : null,
            refus: reponse.stop_reason === 'refusal'
        });
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return res.status(502).json({ error: 'Clé API Anthropic invalide.' });
        if (err instanceof Anthropic.RateLimitError) return res.status(502).json({ error: 'Trop de requêtes vers l\'assistant, réessayez dans un instant.' });
        if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `Assistant indisponible (${err.status}).` });
        console.error('Chat:', err.message);
        res.status(500).json({ error: 'Erreur assistant : ' + err.message });
    }
});

// ===== V30 — RECONNAISSANCE DU VEHICULE SUR LA PHOTO =====
// Le moteur n'a besoin que du TYPE parmi six : c'est lui qui donne la surface validee.
// Le modele et la plaque ne servent qu'a l'affichage, pour que l'utilisateur verifie d'un
// coup d'oeil que la machine a reconnu le bon vehicule. Rien de tout cela n'est enregistre.
const OUTIL_VEHICULE = {
    name: 'vehicule_reconnu',
    description: "Decrit le vehicule visible sur la photo, pour preremplir un devis de covering.",
    strict: true,
    input_schema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['citadine', 'berline', 'suv', 'utilitaire', 'fourgon', 'camion'],
                description: 'Categorie de carrosserie. utilitaire = Kangoo, Partner, Citan. fourgon = Trafic, Transit, Master, Daily. camion = porteur ou poids lourd.'
            },
            modele: { type: ['string', 'null'], description: 'Marque et modele si identifiables avec certitude, sinon null' },
            plaque: { type: ['string', 'null'], description: "Plaque d'immatriculation si elle est nettement lisible, sinon null" },
            confiance: { type: 'string', enum: ['haute', 'moyenne', 'faible'] },
            commentaire: { type: 'string', description: 'Une phrase courte, en francais, disant sur quoi repose le choix du type.' }
        },
        required: ['type', 'modele', 'plaque', 'confiance', 'commentaire'],
        additionalProperties: false
    }
};

app.post('/api/reconnaitre-vehicule', verifyToken, async (req, res) => {
    // Le SDK Anthropic a besoin de fetch, absent avant Node 18. Sans ce controle,
    // l'utilisateur recoit un message sur des polyfills, incomprehensible pour lui.
    if (typeof fetch !== 'function') {
        return res.status(503).json({ error: "Serveur sur une version de Node trop ancienne (fetch absent) : cette fonction a besoin de Node 18 ou plus." });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: "Reconnaissance non configurée : la clé ANTHROPIC_API_KEY n'est pas définie sur le serveur." });
    }
    try {
        const photoId = parseInt(req.body.photo_id, 10);
        if (!photoId) return res.status(400).json({ error: 'Photo non précisée' });
        await ensureV26Tables();
        // Filtre d'equipe : on ne lit jamais la photo d'une autre entreprise.
        const [rows] = await avecConnexion(conn => conn.query(
            'SELECT mime, octets FROM devis_photos WHERE id = ? AND equipe_id = ?', [photoId, req.userId]));
        if (!rows.length) return res.status(404).json({ error: 'Photo introuvable' });

        const client = new Anthropic();
        const reponse = await client.messages.create({
            // Haiku suffit pour ranger une carrosserie dans six categories, et l'appel a lieu
            // a chaque photo : inutile d'y mettre le modele le plus cher.
            model: 'claude-haiku-5-5',
            max_tokens: 500,
            tools: [OUTIL_VEHICULE],
            tool_choice: { type: 'tool', name: 'vehicule_reconnu' },
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: rows[0].mime, data: Buffer.from(rows[0].octets).toString('base64') } },
                    { type: 'text', text: "Quel véhicule est sur cette photo ? Réponds avec l'outil. Le type de carrosserie est ce qui compte : il détermine la surface à couvrir. Si la photo ne montre pas de véhicule, choisis le type le plus proche et indique une confiance faible en l'expliquant." }
                ]
            }]
        });
        const appel = reponse.content.find(b => b.type === 'tool_use');
        if (!appel) return res.status(502).json({ error: "La reconnaissance n'a rien renvoyé d'exploitable." });
        res.json(appel.input);
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return res.status(502).json({ error: 'Clé API Anthropic invalide.' });
        if (err instanceof Anthropic.RateLimitError) return res.status(502).json({ error: 'Trop de demandes, réessayez dans un instant.' });
        if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `Reconnaissance indisponible (${err.status}).` });
        console.error('Reconnaissance vehicule :', err.message);
        res.status(500).json({ error: 'Erreur de reconnaissance : ' + err.message });
    }
});

// ===== V8 — STOCK (module independant du moteur de prix) =====
const STOCK_TABLES = {
    vinyles: { table: 'vinyles', nameCol: 'name' },
    materiaux: { table: 'materiaux', nameCol: 'support' },
    laminations: { table: 'laminations', nameCol: 'nom' },
    tapes: { table: 'tapes', nameCol: 'nom' }
};

// nomExpediteur : ce que le destinataire voit dans sa boite mail. Il depend du type de
// message — une convocation a une reunion ne doit pas arriver signee "DropStyle Stock".
//
// Ne rejette jamais : un email rate ne doit pas faire echouer l'action en cours (invitation,
// devis, alerte). Renvoie en revanche le resultat reel, pour que l'interface puisse le dire
// au lieu de laisser l'utilisateur croire que le message est parti.
// Resultat : { ok: true } ou { ok: false, message: "<phrase lisible>" }
function sendBrevoEmail(to, subject, text, nomExpediteur) {
    return new Promise((resolve) => {
        const apiKey = process.env.BREVO_API_KEY;
        if (!apiKey) {
            console.log('BREVO_API_KEY non configurée — email non envoyé : ' + subject);
            return resolve({ ok: false, message: "la clé BREVO_API_KEY n'est pas configurée sur le serveur" });
        }
        const payload = JSON.stringify({
            sender: { email: process.env.BREVO_FROM_EMAIL || 'contact@dropstyle.fr', name: nomExpediteur || 'DropStyle' },
            to: to.map(email => ({ email })),
            subject,
            textContent: text
        });
        const request = https.request('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (r) => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => {
                if (r.statusCode < 400) return resolve({ ok: true });
                console.error('Brevo HTTP ' + r.statusCode + ': ' + d);
                // Brevo renvoie {"message": "...", "code": "..."} : on remonte sa phrase telle
                // quelle, c'est elle qui dit quoi corriger (IP non autorisee, expediteur non
                // valide, cle invalide...).
                let detail = '';
                try { detail = JSON.parse(d).message || ''; } catch (e) { detail = (d || '').slice(0, 300); }
                resolve({ ok: false, message: `Brevo a refusé l'envoi (erreur ${r.statusCode})${detail ? ' : ' + detail : ''}` });
            });
        });
        request.on('error', (e) => {
            console.error('Brevo:', e.message);
            resolve({ ok: false, message: 'le serveur de mail est injoignable (' + e.message + ')' });
        });
        request.write(payload);
        request.end();
    });
}

// equipeId est obligatoire : sans filtre d'equipe, l'alerte partait a TOUS les
// administrateurs du logiciel, qui recevaient par mail le nom des matieres et les stocks
// d'une entreprise qui n'est pas la leur.
async function sendStockAlertEmail(equipeId, nom, stock, seuil) {
    const [admins] = await avecConnexion(conn => conn.query(
        "SELECT email FROM users WHERE role = 'admin' AND COALESCE(equipe_id, id) = ?", [equipeId]));
    if (!admins.length) return;
    const envoi = await sendBrevoEmail(admins.map(a => a.email), `⚠️ Stock faible : ${nom}`,
        `Le stock de "${nom}" est passé à ${stock}m² (seuil d'alerte : ${seuil}m²). Pensez à réapprovisionner.`,
        'DropStyle Stock');
    if (!envoi.ok) console.error(`Alerte stock "${nom}" non envoyée — ${envoi.message}`);
}

app.get('/api/stock', verifyToken, async (req, res) => {
    try {
        await ensureV8Tables();
        const items = await avecConnexion(async (conn) => {
            const [paramRows] = await conn.query('SELECT valeur FROM parametres WHERE user_id = ? AND cle = ?', [req.userId, 'seuil_stock_defaut']);
            const seuilDefaut = paramRows.length ? parseFloat(paramRows[0].valeur) : DEFAULT_PARAMS.seuil_stock_defaut;
            const liste = [];
            for (const [type, cfg] of Object.entries(STOCK_TABLES)) {
                const [rows] = await conn.query(`SELECT id, ${cfg.nameCol} AS nom, stock_m2, seuil_alerte FROM ${cfg.table} WHERE user_id = ?`, [req.userId]);
                rows.forEach(r => {
                    const seuil = r.seuil_alerte !== null ? parseFloat(r.seuil_alerte) : seuilDefaut;
                    const stock = r.stock_m2 !== null ? parseFloat(r.stock_m2) : null;
                    liste.push({ type, id: r.id, nom: r.nom, stock_m2: stock, seuil_alerte: r.seuil_alerte !== null ? parseFloat(r.seuil_alerte) : null, seuil_effectif: seuil, low: stock !== null && stock <= seuil });
                });
            }
            return liste;
        });
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/stock/:type/:id', verifyToken, async (req, res) => {
    try {
        const cfg = STOCK_TABLES[req.params.type];
        if (!cfg) return res.status(400).json({ error: 'Type invalide' });
        await ensureV8Tables();
        const stockVal = req.body.stock_m2 === '' || req.body.stock_m2 === undefined ? null : parseFloat(req.body.stock_m2);
        const seuilVal = req.body.seuil_alerte === '' || req.body.seuil_alerte === undefined ? null : parseFloat(req.body.seuil_alerte);
        await avecConnexion(async (conn) => {
            const [before] = await conn.query(`SELECT alerte_envoyee, ${cfg.nameCol} AS nom FROM ${cfg.table} WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
            if (!before.length) return res.status(404).json({ error: 'Introuvable' });
            await conn.query(`UPDATE ${cfg.table} SET stock_m2 = ?, seuil_alerte = ? WHERE id = ? AND user_id = ?`, [stockVal, seuilVal, req.params.id, req.userId]);

            const [paramRows] = await conn.query('SELECT valeur FROM parametres WHERE user_id = ? AND cle = ?', [req.userId, 'seuil_stock_defaut']);
            const seuilDefaut = paramRows.length ? parseFloat(paramRows[0].valeur) : DEFAULT_PARAMS.seuil_stock_defaut;
            const seuilEffectif = seuilVal !== null ? seuilVal : seuilDefaut;
            const etaitBas = before[0].alerte_envoyee === 1;
            const estBas = stockVal !== null && stockVal <= seuilEffectif;

            if (estBas && !etaitBas) {
                await conn.query(`UPDATE ${cfg.table} SET alerte_envoyee = 1 WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
                sendStockAlertEmail(req.userId, before[0].nom, stockVal, seuilEffectif).catch(e => console.error('Email stock:', e.message));
            } else if (!estBas && etaitBas) {
                await conn.query(`UPDATE ${cfg.table} SET alerte_envoyee = 0 WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
            }

            res.json({ message: 'OK', low: estBas });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V11 — SOURCES D'ACQUISITION =====
app.get('/api/sources-client', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const rows = await avecConnexion(async (conn) => {
            await ensureSourcesEquipe(conn, req.userId);
            const [lignes] = await conn.query('SELECT id, nom FROM sources_client WHERE equipe_id = ? ORDER BY ordre, nom', [req.userId]);
            return lignes;
        });
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/sources-client', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const nom = (req.body.nom || '').trim();
        if (!nom) return res.status(400).json({ error: 'Nom requis' });
        await avecConnexion(async (conn) => {
            const [[{ maxi }]] = await conn.query('SELECT COALESCE(MAX(ordre), 0) AS maxi FROM sources_client WHERE equipe_id = ?', [req.userId]);
            await conn.query('INSERT INTO sources_client (equipe_id, nom, ordre) VALUES (?, ?, ?)', [req.userId, nom, maxi + 1]);
        });
        res.status(201).json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/sources-client/:id', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        await avecConnexion(conn => conn.query('DELETE FROM sources_client WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]));
        // Les clients gardent la source deja saisie : supprimer la source de la liste ne
        // reecrit pas l'historique, sinon les statistiques passees deviendraient fausses.
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V11 — CLIENTS / PROSPECTS =====
app.get('/api/clients', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            `SELECT c.*, COUNT(d.id) AS nb_devis, COALESCE(SUM(d.ht), 0) AS ca_devis
             FROM clients c LEFT JOIN devis d ON d.client_id = c.id
             WHERE c.equipe_id = ? GROUP BY c.id ORDER BY c.nom`, [req.userId]));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/clients/:id', verifyToken, async (req, res) => {
    try {
        await avecConnexion(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM clients WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]);
            if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });
            const [devis] = await conn.query('SELECT id, type, qty, ht, ttc, created_at FROM devis WHERE client_id = ? ORDER BY created_at DESC', [req.params.id]);
            res.json({ client: rows[0], devis });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/clients', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const { nom, type, source, email, telephone, notes } = req.body;
        if (!(nom || '').trim()) return res.status(400).json({ error: 'Nom requis' });
        const [r] = await avecConnexion(conn => conn.query(
            'INSERT INTO clients (equipe_id, nom, type, source, email, telephone, notes, auteur_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [req.userId, nom.trim(), type === 'client' ? 'client' : 'prospect', (source || '').trim() || null,
             (email || '').trim() || null, (telephone || '').trim() || null, (notes || '').trim() || null, req.authUserId]));
        res.status(201).json({ id: r.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/clients/:id', verifyToken, async (req, res) => {
    try {
        const { nom, type, source, email, telephone, notes } = req.body;
        await avecConnexion(conn => conn.query(
            'UPDATE clients SET nom = ?, type = ?, source = ?, email = ?, telephone = ?, notes = ? WHERE id = ? AND equipe_id = ?',
            [(nom || '').trim(), type === 'client' ? 'client' : 'prospect', (source || '').trim() || null,
             (email || '').trim() || null, (telephone || '').trim() || null, (notes || '').trim() || null,
             req.params.id, req.userId]));
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/clients/:id', verifyToken, async (req, res) => {
    try {
        await avecConnexion(async (conn) => {
            // L'appartenance est verifiee AVANT de toucher aux devis. Sans ce controle, et
            // sans le filtre d'equipe sur l'UPDATE ci-dessous, n'importe quel compte connecte
            // pouvait detacher les devis d'une AUTRE entreprise de leurs clients : les liens
            // etaient perdus et les statistiques par source de cette entreprise faussees.
            const [client] = await conn.query('SELECT id FROM clients WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]);
            if (!client.length) return res.status(404).json({ error: 'Client introuvable' });
            // Les devis sont conserves : on detache seulement le lien, le nom saisi reste lisible.
            // devis.user_id porte l'equipe proprietaire : c'est lui qui borne la mise a jour.
            await conn.query('UPDATE devis SET client_id = NULL WHERE client_id = ? AND user_id = ?', [req.params.id, req.userId]);
            await conn.query('DELETE FROM clients WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]);
            res.json({ message: 'OK' });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V11 — STATISTIQUES PAR SOURCE =====
// Un prospect sans devis compte dans le nombre de contacts mais pas dans le CA : c'est
// exactement ce qu'on veut voir, un canal qui ramene du monde sans ramener d'argent.
app.get('/api/stats/sources', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            `SELECT COALESCE(NULLIF(c.source, ''), 'Non renseignée') AS source,
                    COUNT(DISTINCT c.id) AS total,
                    COUNT(DISTINCT CASE WHEN c.type = 'client' THEN c.id END) AS clients,
                    COUNT(DISTINCT CASE WHEN c.type = 'prospect' THEN c.id END) AS prospects,
                    COUNT(d.id) AS nb_devis,
                    COALESCE(SUM(d.ht), 0) AS ca_devis
             FROM clients c LEFT JOIN devis d ON d.client_id = c.id
             WHERE c.equipe_id = ? GROUP BY source ORDER BY ca_devis DESC, total DESC`, [req.userId]));
        res.json(rows.map(r => ({
            ...r,
            ca_devis: Number(r.ca_devis),
            taux: r.total > 0 ? Math.round((r.clients / r.total) * 100) : 0
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V11 — EQUIPE ET NOTIFICATIONS INTERNES =====
app.get('/api/equipe', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query('SELECT id, nom, email, role FROM users WHERE COALESCE(equipe_id, id) = ? ORDER BY nom', [req.userId]));
        res.json({ moi: req.authUserId, membres: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        await avecConnexion(async (conn) => {
            const [rows] = await conn.query(
                `SELECT n.*, u.nom AS de_nom FROM notifications n
                 LEFT JOIN users u ON u.id = n.de_user_id
                 WHERE n.vers_user_id = ? ORDER BY n.lu, n.created_at DESC LIMIT 50`, [req.authUserId]);
            const [[{ nonLus }]] = await conn.query('SELECT COUNT(*) AS nonLus FROM notifications WHERE vers_user_id = ? AND lu = 0', [req.authUserId]);
            res.json({ nonLus, notifications: rows });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/notifications', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const { vers_user_id, type, titre, message, ref_type, ref_id, date_rdv, envoyer_email } = req.body;
        if (!(titre || '').trim()) return res.status(400).json({ error: 'Titre requis' });
        // La connexion est rendue avant l'envoi de l'email : garder une connexion du pool
        // pendant un appel au serveur de mail la retirerait aux autres utilisateurs.
        const enregistre = await avecConnexion(async (conn) => {
            // Le destinataire doit appartenir a la meme equipe : sans ce controle, n'importe quel
            // compte pourrait ecrire a n'importe quel utilisateur du logiciel.
            const [dest] = await conn.query('SELECT id, nom, email FROM users WHERE id = ? AND COALESCE(equipe_id, id) = ?', [vers_user_id, req.userId]);
            if (!dest.length) return null;
            await conn.query(
                'INSERT INTO notifications (equipe_id, de_user_id, vers_user_id, type, titre, message, ref_type, ref_id, date_rdv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [req.userId, req.authUserId, vers_user_id, type || 'message', titre.trim(), (message || '').trim() || null,
                 ref_type || null, ref_id || null, date_rdv || null]);
            const [expediteur] = await conn.query('SELECT nom FROM users WHERE id = ?', [req.authUserId]);
            return { dest, expediteur };
        });
        if (!enregistre) return res.status(400).json({ error: 'Destinataire hors de votre équipe' });
        const { dest, expediteur } = enregistre;
        // La notification est deja enregistree : elle apparaitra sur la cloche meme si l'email
        // echoue. On attend seulement pour pouvoir signaler cet echec a l'ecran.
        let envoi = null;
        if (envoyer_email && dest[0].email) {
            const de = expediteur.length ? expediteur[0].nom : 'Un collègue';
            const quand = date_rdv ? `\n\nDate : ${new Date(date_rdv).toLocaleString('fr-FR')}` : '';
            // Le nom du collegue apparait comme expediteur : le destinataire voit tout de suite
            // qui lui ecrit, sans avoir a ouvrir le message.
            envoi = await sendBrevoEmail([dest[0].email], `DropStyle — ${titre.trim()}`,
                `${de} vous a envoyé un message dans DropStyle :\n\n${titre.trim()}\n${message || ''}${quand}`,
                `${de} · DropStyle`);
        }
        // Hors du chemin critique : la notification est deja en base et s'affichera sur la
        // cloche meme si le push echoue. On n'attend pas non plus les serveurs de push.
        envoyerPush(vers_user_id, {
            titre: titre.trim(),
            message: (message || '').trim().slice(0, 120),
            de: expediteur.length ? expediteur[0].nom : 'Un collègue',
            url: '/app'
        }).catch(() => { /* deja journalise */ });
        res.status(201).json({ message: 'OK', envoi });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/notifications/toutes-lues', verifyToken, async (req, res) => {
    try {
        await avecConnexion(conn => conn.query('UPDATE notifications SET lu = 1 WHERE vers_user_id = ?', [req.authUserId]));
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/notifications/:id/lu', verifyToken, async (req, res) => {
    try {
        await avecConnexion(conn => conn.query('UPDATE notifications SET lu = 1 WHERE id = ? AND vers_user_id = ?', [req.params.id, req.authUserId]));
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V12 — INVITATIONS =====
// Le lien contient un jeton aleatoire : c'est lui qui rattache l'invite a l'equipe.
// Sans cela, une personne qui s'inscrit seule atterrit dans une equipe vide et ne voit
// aucune donnee de l'entreprise.
const DUREE_INVITATION_JOURS = 7;

app.get('/api/invitations', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            `SELECT id, email, role, expire_le, utilise_le, created_at FROM invitations
             WHERE equipe_id = ? ORDER BY created_at DESC LIMIT 50`, [req.userId]));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invitations', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        await ensureV11Tables();
        const email = (req.body.email || '').trim().toLowerCase();
        const role = req.body.role === 'admin' ? 'admin' : 'user';
        const message = (req.body.message || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide' });

        // La connexion est rendue avant l'envoi de l'email : garder une connexion du pool
        // pendant un appel au serveur de mail la retirerait aux autres utilisateurs.
        const cree = await avecConnexion(async (conn) => {
            const [existant] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
            if (existant.length) return null;

            // Une nouvelle invitation pour la meme adresse annule les precedentes encore valides :
            // sinon un ancien lien resterait utilisable apres un changement d'avis.
            await conn.query('UPDATE invitations SET utilise_le = NOW() WHERE equipe_id = ? AND email = ? AND utilise_le IS NULL', [req.userId, email]);

            const token = require('crypto').randomBytes(24).toString('hex');
            await conn.query(
                'INSERT INTO invitations (equipe_id, email, token, role, cree_par, expire_le) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
                [req.userId, email, token, role, req.authUserId, DUREE_INVITATION_JOURS]);
            const [inviteur] = await conn.query('SELECT nom FROM users WHERE id = ?', [req.authUserId]);
            return { token, inviteur };
        });
        if (!cree) return res.status(400).json({ error: 'Un compte existe déjà avec cette adresse' });
        const { token, inviteur } = cree;

        const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        const lien = `${base}/invitation?token=${token}`;
        const de = inviteur.length ? inviteur[0].nom : 'DropStyle';
        const corps = (message || `Bonjour,\n\n${de} vous invite à rejoindre DropStyle, le calculateur de devis de l'entreprise.`)
            + `\n\nCliquez sur ce lien pour créer votre accès :\n${lien}`
            + `\n\nCe lien est personnel et valable ${DUREE_INVITATION_JOURS} jours.`;
        // Attendu pour pouvoir dire a l'admin ce qui s'est reellement passe. Un echec
        // n'annule pas l'invitation : le lien reste valable et affiche a l'ecran.
        const envoi = await sendBrevoEmail([email], `Invitation à rejoindre DropStyle`, corps, `${de} · DropStyle`);

        res.status(201).json({ lien, email, expire_dans_jours: DUREE_INVITATION_JOURS, envoi });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/invitations/:id', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        await avecConnexion(conn => conn.query('DELETE FROM invitations WHERE id = ? AND equipe_id = ?', [req.params.id, req.userId]));
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publics : consultes par la page d'invitation, avant toute connexion.
app.get('/api/invitations/verifier/:token', async (req, res) => {
    try {
        await ensureV11Tables();
        const [rows] = await avecConnexion(conn => conn.query(
            `SELECT i.email, i.expire_le, i.utilise_le, u.nom AS inviteur
             FROM invitations i LEFT JOIN users u ON u.id = i.cree_par
             WHERE i.token = ?`, [req.params.token]));
        if (!rows.length) return res.status(404).json({ error: "Cette invitation n'existe pas." });
        if (rows[0].utilise_le) return res.status(410).json({ error: 'Cette invitation a déjà été utilisée.' });
        if (new Date(rows[0].expire_le) < new Date()) return res.status(410).json({ error: 'Cette invitation a expiré. Demandez-en une nouvelle.' });
        res.json({ email: rows[0].email, inviteur: rows[0].inviteur });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invitations/accepter', authLimiter, async (req, res) => {
    try {
        await ensureV11Tables();
        const { token, nom, password } = req.body;
        if (!token || !(nom || '').trim() || !password) return res.status(400).json({ error: 'Nom et mot de passe requis' });
        if (String(password).length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });

        await avecConnexion(async (conn) => {
            const [rows] = await conn.query('SELECT * FROM invitations WHERE token = ?', [token]);
            if (!rows.length) return res.status(404).json({ error: "Cette invitation n'existe pas." });
            const inv = rows[0];
            if (inv.utilise_le) return res.status(410).json({ error: 'Cette invitation a déjà été utilisée.' });
            if (new Date(inv.expire_le) < new Date()) return res.status(410).json({ error: 'Cette invitation a expiré.' });

            const [existant] = await conn.query('SELECT id FROM users WHERE email = ?', [inv.email]);
            if (existant.length) return res.status(400).json({ error: 'Un compte existe déjà avec cette adresse.' });

            const bcrypt = require('bcrypt');
            const hash = await bcrypt.hash(password, 10);
            // L'invite est connecte dans la foulee : c'est bien une premiere connexion.
            const [r] = await conn.query('INSERT INTO users (email, password, nom, role, equipe_id, derniere_connexion, nb_connexions) VALUES (?, ?, ?, ?, ?, NOW(), 1)',
                [inv.email, hash, nom.trim(), inv.role, inv.equipe_id]);
            await conn.query('UPDATE invitations SET utilise_le = NOW() WHERE id = ?', [inv.id]);

            // Connexion immediate : l'invite vient de choisir son mot de passe, lui redemander
            // de se connecter n'apporte rien.
            const jwt = require('jsonwebtoken');
            const jeton = jwt.sign({ id: r.insertId, email: inv.email, role: inv.role, equipe_id: inv.equipe_id }, JWT_SECRET, { expiresIn: '7d' });
            res.status(201).json({ token: jeton, user: { id: r.insertId, email: inv.email, nom: nom.trim(), role: inv.role } });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== V15 — CLASSEMENT ET RECAPITULATIF HEBDOMADAIRE =====
// Trois categories : devis crees, devis valides, CA valide. Le CA valide compte, sinon
// celui qui multiplie les petits devis passerait devant celui qui decroche la grosse affaire.
const DEBUT_PERIODE = {
    semaine: 'DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)',      // lundi de cette semaine
    mois:    'DATE_FORMAT(CURDATE(), "%Y-%m-01")'
};

async function classementEquipe(conn, equipeId, periode, debutExplicite, finExplicite) {
    // La clause de periode et ses parametres sont construits ensemble, et les parametres sont
    // assembles dans l'ordre exact ou les "?" apparaissent dans la requete : l'equipe
    // proprietaire, puis les bornes de date, puis l'equipe des membres. Ecrits separement,
    // ils s'etaient decales — la date partait dans le filtre d'equipe et reciproquement,
    // ce qui donnait un classement faux sans aucun message d'erreur.
    const borne = debutExplicite
        ? { sql: 'd.created_at >= ? AND d.created_at < ?', params: [debutExplicite, finExplicite] }
        : { sql: `d.created_at >= ${DEBUT_PERIODE[periode] || DEBUT_PERIODE.semaine}`, params: [] };
    const params = [equipeId, ...borne.params, equipeId];
    const [rows] = await conn.query(
        `SELECT u.id, u.nom,
                COUNT(d.id) AS nb_devis,
                COALESCE(SUM(d.statut = 'valide'), 0) AS nb_valides,
                COALESCE(SUM(CASE WHEN d.statut = 'valide' THEN d.ht ELSE 0 END), 0) AS ca_valide
         FROM users u
         LEFT JOIN devis d ON d.auteur_id = u.id AND d.user_id = ? AND ${borne.sql}
         WHERE COALESCE(u.equipe_id, u.id) = ?
         GROUP BY u.id, u.nom
         ORDER BY nb_valides DESC, ca_valide DESC, nb_devis DESC`, params);
    return rows.map(r => ({
        id: r.id, nom: r.nom,
        nb_devis: Number(r.nb_devis),
        nb_valides: Number(r.nb_valides),
        ca_valide: Number(r.ca_valide)
    }));
}

// Visible par toute l'equipe : un classement que personne ne regarde ne motive personne.
app.get('/api/classement', verifyToken, async (req, res) => {
    try {
        await ensureV11Tables();
        const periode = DEBUT_PERIODE[req.query.periode] ? req.query.periode : 'semaine';
        const lignes = await avecConnexion(conn => classementEquipe(conn, req.userId, periode));
        res.json({ periode, moi: req.authUserId, lignes });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Recapitulatif hebdomadaire par email ---
// Railway n'offre pas de planificateur : le serveur verifie lui-meme, a intervalle regulier,
// si le recap de la semaine ecoulee a deja ete envoye. La trace est en base et non en memoire,
// pour qu'un redemarrage ne provoque pas de second envoi.
const RECAP_JOUR = 5;    // 5 = vendredi (1 = lundi)
const RECAP_HEURE = 18;
const FUSEAU = process.env.FUSEAU_HORAIRE || 'Europe/Paris';

function maintenantLocal() {
    // On relit l'heure dans le fuseau de l'entreprise : le serveur, lui, tourne en UTC.
    const p = new Intl.DateTimeFormat('fr-FR', {
        timeZone: FUSEAU, weekday: 'short', hour: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const v = t => p.find(x => x.type === t)?.value;
    const jours = { lun: 1, mar: 2, mer: 3, jeu: 4, ven: 5, sam: 6, dim: 7 };
    return {
        jour: jours[(v('weekday') || '').slice(0, 3).toLowerCase().replace('.', '')] || 0,
        heure: parseInt(v('hour'), 10),
        date: `${v('year')}-${v('month')}-${v('day')}`
    };
}

function cleSemaine(d) {
    // Identifiant de la semaine ISO, pour ne jamais envoyer deux fois le meme recap.
    const t = new Date(d + 'T00:00:00Z');
    const jeudi = new Date(t); jeudi.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
    const debut = new Date(Date.UTC(jeudi.getUTCFullYear(), 0, 1));
    const no = Math.ceil(((jeudi - debut) / 86400000 + 1) / 7);
    return `${jeudi.getUTCFullYear()}-S${String(no).padStart(2, '0')}`;
}

function texteClassement(lignes) {
    const medailles = ['🥇', '🥈', '🥉'];
    return lignes.map((l, i) =>
        `${medailles[i] || ' ' + (i + 1) + '.'} ${l.nom} — ${l.nb_valides} devis validés`
        + ` (${l.ca_valide.toFixed(0)} € HT), ${l.nb_devis} devis chiffrés`).join('\n');
}

async function envoyerRecapSemaine(conn, equipeId, cle) {
    const lignes = await classementEquipe(conn, equipeId, 'semaine');
    const actifs = lignes.filter(l => l.nb_devis > 0);
    // Deux garde-fous : feliciter quelqu'un d'avoir battu personne n'a pas de sens, et un
    // classement vide chaque vendredi finirait en indesirable.
    if (actifs.length < 2) return { envoye: false, raison: 'moins de deux personnes actives' };

    const [membres] = await conn.query(
        'SELECT nom, email FROM users WHERE COALESCE(equipe_id, id) = ? AND email IS NOT NULL', [equipeId]);
    if (!membres.length) return { envoye: false, raison: 'aucun destinataire' };

    const maxVal = Math.max(...lignes.map(l => l.nb_valides));
    const maxCree = Math.max(...lignes.map(l => l.nb_devis));
    // Egalites : on nomme tous les ex aequo plutot que d'en departager un arbitrairement.
    const champVal = lignes.filter(l => l.nb_valides === maxVal && maxVal > 0).map(l => l.nom);
    const champCree = lignes.filter(l => l.nb_devis === maxCree && maxCree > 0).map(l => l.nom);

    const liste = n => n.length > 1 ? n.slice(0, -1).join(', ') + ' et ' + n[n.length - 1] : n[0];
    let corps = '🏆 Classement de la semaine\n\n' + texteClassement(lignes) + '\n\n';
    if (champCree.length) corps += `✏️ Le plus de devis chiffrés : ${liste(champCree)} (${maxCree})\n`;
    if (champVal.length) corps += `✅ Le plus de devis validés : ${liste(champVal)} (${maxVal})\n`;
    corps += '\nFélicitations, et bonne semaine à toute l\'équipe !';

    const envoi = await sendBrevoEmail(membres.map(m => m.email), '🏆 DropStyle — classement de la semaine', corps, 'DropStyle');
    if (!envoi.ok) return { envoye: false, raison: envoi.message };
    await conn.query('INSERT INTO recaps_envoyes (equipe_id, periode, envoye_le) VALUES (?, ?, NOW())', [equipeId, cle]);
    return { envoye: true, destinataires: membres.length };
}

async function verifierRecaps() {
    const t = maintenantLocal();
    if (t.jour !== RECAP_JOUR || t.heure < RECAP_HEURE) return;
    let conn;
    try {
        conn = await pool.getConnection();
        const cle = cleSemaine(t.date);
        const [equipes] = await conn.query('SELECT DISTINCT COALESCE(equipe_id, id) AS eq FROM users');
        for (const { eq } of equipes) {
            const [deja] = await conn.query('SELECT id FROM recaps_envoyes WHERE equipe_id = ? AND periode = ?', [eq, cle]);
            if (deja.length) continue;
            const r = await envoyerRecapSemaine(conn, eq, cle);
            console.log(`Recap ${cle} equipe ${eq} :`, r.envoye ? `envoye a ${r.destinataires} personnes` : `non envoye (${r.raison})`);
        }
    } catch (e) {
        console.error('Recap hebdomadaire :', e.message);
    } finally {
        if (conn) await conn.release();
    }
}

// ADMIN
app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const rows = await avecConnexion(async (conn) => {
            await ensureV11Tables(conn);
            const [lignes] = await conn.query('SELECT id, email, nom, role, created_at FROM users WHERE COALESCE(equipe_id, id) = ?', [req.userId]);
            return lignes;
        });
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/users', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const { email, password, nom, role } = req.body;
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(password, 10);
        await avecConnexion(async (conn) => {
            await ensureV11Tables(conn);
            // Le nouveau compte rejoint l'equipe de l'admin qui le cree : il partage donc
            // immediatement les tarifs, les devis et les clients de l'entreprise.
            await conn.query('INSERT INTO users (email, password, nom, role, equipe_id) VALUES (?, ?, ?, ?, ?)', [email, hashedPassword, nom, role, req.userId]);
        });
        res.status(201).json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// V20 — rattacher un compte existant a l'equipe. Un compte cree par l'onglet Inscription
// devient sa propre equipe, isolee : il n'apparait dans aucune liste et ne voit aucune donnee
// de l'entreprise. L'invitation refuse une adresse deja prise, et "Modifier" ne voit que
// l'equipe : sans ce rattachement, un tel compte reste definitivement a l'ecart.
app.post('/api/admin/equipe/rattacher', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        // Validee avant d'ouvrir une connexion : inutile de solliciter la base pour rien.
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Adresse email requise' });
        await ensureV11Tables();

        const conn = await pool.getConnection();
        try {
            const [rows] = await conn.query('SELECT id, nom, email, role, COALESCE(equipe_id, id) AS eq FROM users WHERE LOWER(email) = ?', [email]);
            if (!rows.length) return res.status(404).json({ error: "Aucun compte avec cette adresse. Utilisez « + Ajouter » pour le créer." });
            const u = rows[0];
            if (String(u.id) === String(req.userId)) return res.status(400).json({ error: 'Ce compte est déjà le compte principal de votre équipe.' });
            if (String(u.eq) === String(req.userId)) return res.status(400).json({ error: 'Ce compte fait déjà partie de votre équipe.' });

            // Si d'autres comptes dependent de lui, le deplacer les laisserait orphelins.
            const [[{ membres }]] = await conn.query('SELECT COUNT(*) AS membres FROM users WHERE COALESCE(equipe_id, id) = ? AND id <> ?', [u.eq, u.id]);
            if (membres > 0) return res.status(400).json({ error: `Ce compte dirige une équipe de ${membres} autre(s) personne(s). Le rattacher les laisserait sans équipe.` });

            // Donnees lui appartenant en propre : les rattacher les rendrait invisibles sans
            // explication, puisque tout est filtre par equipe.
            const [[{ nbDevis }]] = await conn.query('SELECT COUNT(*) AS nbDevis FROM devis WHERE user_id = ?', [u.eq]);
            const [[{ nbClients }]] = await conn.query('SELECT COUNT(*) AS nbClients FROM clients WHERE equipe_id = ?', [u.eq]);
            if (nbDevis > 0 || nbClients > 0) {
                return res.status(409).json({
                    error: `Ce compte possède déjà ${nbDevis} devis et ${nbClients} client(s). `
                         + `Le rattacher les rendrait invisibles. Contactez-moi avant de forcer.`,
                    nb_devis: nbDevis, nb_clients: nbClients
                });
            }

            await conn.query('UPDATE users SET equipe_id = ? WHERE id = ?', [req.userId, u.id]);
            // Son jeton porte encore l'ancienne equipe : il doit se reconnecter.
            res.json({ message: 'OK', nom: u.nom, email: u.email, role: u.role, reconnexion_requise: true });
        } finally {
            await conn.release();
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// V19 — modification d'un compte : role et mot de passe. Il manquait tout moyen de promouvoir
// un collegue ou de remplacer un mot de passe, ce qui obligeait a supprimer puis recreer.
app.put('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const { role, password } = req.body;
        if (role && !['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rôle inconnu' });
        if (password && String(password).length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
        if (!role && !password) return res.status(400).json({ error: 'Rien à modifier' });

        await avecConnexion(async (conn) => {
            const [cible] = await conn.query('SELECT id, role FROM users WHERE id = ? AND COALESCE(equipe_id, id) = ?', [req.params.id, req.userId]);
            if (!cible.length) return res.status(404).json({ error: 'Utilisateur hors de votre équipe' });

            if (role && role !== cible[0].role) {
                // Le compte principal porte les donnees de l'equipe : le retrograder fermerait
                // l'administration a tout le monde.
                if (String(req.params.id) === String(req.userId) && role !== 'admin') {
                    return res.status(400).json({ error: 'Le compte principal de l\'équipe doit rester administrateur' });
                }
                if (cible[0].role === 'admin' && role === 'user') {
                    const [[{ count }]] = await conn.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND COALESCE(equipe_id, id) = ?", [req.userId]);
                    if (count <= 1) return res.status(400).json({ error: 'Impossible de retirer le dernier administrateur' });
                }
                await conn.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
            }
            if (password) {
                const bcrypt = require('bcrypt');
                await conn.query('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(password, 10), req.params.id]);
            }
            // Le jeton du compte modifie porte encore l'ancien role jusqu'a sa prochaine connexion.
            res.json({ message: 'OK', reconnexion_requise: !!(role && role !== cible[0].role) });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        // Comparaison sur la personne connectee, pas sur le proprietaire des donnees :
        // un second admin de l'equipe doit rester protege contre sa propre suppression.
        if (String(req.params.id) === String(req.authUserId)) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
        await avecConnexion(async (conn) => {
            const [target] = await conn.query('SELECT role FROM users WHERE id = ? AND COALESCE(equipe_id, id) = ?', [req.params.id, req.userId]);
            if (!target.length) return res.status(404).json({ error: 'Utilisateur hors de votre équipe' });
            if (target[0].role === 'admin') {
                const [[{ count }]] = await conn.query("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND COALESCE(equipe_id, id) = ?", [req.userId]);
                if (count <= 1) return res.status(400).json({ error: 'Impossible de supprimer le dernier compte admin' });
            }
            // Le compte proprietaire porte toutes les donnees de l'equipe : le supprimer les effacerait.
            if (String(req.params.id) === String(req.userId)) return res.status(400).json({ error: 'Impossible de supprimer le compte principal de l\'équipe' });
            await conn.query('DELETE FROM users WHERE id = ?', [req.params.id]);
            res.json({ message: 'OK' });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// V13 — activite par utilisateur. Les devis et clients crees avant la V11 n'ont pas
// d'auteur enregistre : ils sont regroupes a part plutot qu'attribues au hasard.
app.get('/api/admin/utilisateurs-stats', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        await ensureV11Tables();
        const { membres, parDevis, parClient, activite, activiteJours } = await avecConnexion(async (conn) => {
            const [membres] = await conn.query(
                `SELECT id, nom, email, role, created_at, derniere_connexion, COALESCE(nb_connexions, 0) AS nb_connexions
                 FROM users WHERE COALESCE(equipe_id, id) = ? ORDER BY nom`, [req.userId]);
            // devis.user_id = l'equipe proprietaire, devis.auteur_id = la personne qui l'a saisi.
            const [parDevis] = await conn.query(
                // COALESCE(ht_calcule, ht) : avant la V17 il n'y avait pas d'ajustement, le prix
                // vendu etait le prix calcule. L'ecart est alors nul, ce qui est exact.
                `SELECT auteur_id, COUNT(*) AS nb, COALESCE(SUM(ht), 0) AS ca,
                        SUM(statut = 'valide') AS nb_valides,
                        SUM(statut = 'refuse') AS nb_refuses,
                        COALESCE(SUM(CASE WHEN statut = 'valide' THEN ht ELSE 0 END), 0) AS ca_valide,
                        COALESCE(SUM(COALESCE(ht_calcule, ht)), 0) AS ca_calcule
                 FROM devis WHERE user_id = ? GROUP BY auteur_id`, [req.userId]);
            const [parClient] = await conn.query(
                `SELECT auteur_id, COUNT(*) AS nb FROM clients WHERE equipe_id = ? GROUP BY auteur_id`, [req.userId]);
            // Activite hebdomadaire : lundi de chaque semaine, sur 52 semaines — le
            // tableau de bord y decoupe sa fenetre (mois, trimestre, annee) sans rappeler
            // le serveur. L'affichage par defaut reste 12 semaines.
            const [activite] = await conn.query(
                `SELECT DATE(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY)) AS semaine,
                        COUNT(*) AS nb, COALESCE(SUM(ht), 0) AS ca,
                        COALESCE(SUM(CASE WHEN statut = 'valide' THEN ht ELSE 0 END), 0) AS ca_valide,
                        COALESCE(SUM(COALESCE(ht_calcule, ht)), 0) AS ca_calcule,
                        SUM(statut = 'valide') AS nb_valides,
                        SUM(statut = 'refuse') AS nb_refuses
                 FROM devis WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 52 WEEK)
                 GROUP BY semaine ORDER BY semaine`, [req.userId]);
            // Les sept derniers jours : une courbe hebdomadaire reduite a un point ne
            // montrerait rien, le segment « Cette semaine » passe donc au jour.
            const [activiteJours] = await conn.query(
                `SELECT DATE(created_at) AS jour,
                        COUNT(*) AS nb, COALESCE(SUM(ht), 0) AS ca,
                        COALESCE(SUM(CASE WHEN statut = 'valide' THEN ht ELSE 0 END), 0) AS ca_valide,
                        COALESCE(SUM(COALESCE(ht_calcule, ht)), 0) AS ca_calcule,
                        SUM(statut = 'valide') AS nb_valides,
                        SUM(statut = 'refuse') AS nb_refuses
                 FROM devis WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                 GROUP BY jour ORDER BY jour`, [req.userId]);
            return { membres, parDevis, parClient, activite, activiteJours };
        });

        const devisPar = new Map(parDevis.map(r => [r.auteur_id, r]));
        const clientsPar = new Map(parClient.map(r => [r.auteur_id, r]));
        const chiffres = (d) => {
            const ca = d ? Number(d.ca) : 0;
            const calcule = d ? Number(d.ca_calcule) : 0;
            return {
                nb_devis: d ? Number(d.nb) : 0,
                ca_devis: ca,
                nb_valides: d ? Number(d.nb_valides) : 0,
                nb_refuses: d ? Number(d.nb_refuses) : 0,
                ca_valide: d ? Number(d.ca_valide) : 0,
                ca_calcule: calcule,
                // Ecart moyen entre ce qui est vendu et ce que le moteur chiffre. Un ecart
                // positif durable signifie que le moteur est regle trop bas.
                ecart_pct: calcule > 0 ? Math.round(((ca - calcule) / calcule) * 1000) / 10 : null
            };
        };
        const utilisateurs = membres.map(m => {
            const c = chiffres(devisPar.get(m.id));
            const tranches = c.nb_valides + c.nb_refuses;
            return {
                ...m, ...c,
                nb_clients: clientsPar.has(m.id) ? clientsPar.get(m.id).nb : 0,
                taux: tranches ? Math.round((c.nb_valides / tranches) * 100) : null
            };
        });
        const orphelinC = clientsPar.get(null);
        res.json({
            utilisateurs,
            sansAuteur: {
                ...chiffres(devisPar.get(null)),
                nb_clients: orphelinC ? orphelinC.nb : 0
            },
            // ca = tout ce qui a ete chiffre ; ca_valide = ce qui est devenu commande.
            // Les deux sont renvoyes, le tableau de bord ne doit pas les confondre.
            activite: activite.map(a => ({
                semaine: a.semaine, nb: a.nb, ca: Number(a.ca),
                ca_valide: Number(a.ca_valide), ca_calcule: Number(a.ca_calcule),
                nb_valides: Number(a.nb_valides), nb_refuses: Number(a.nb_refuses)
            })),
            activite_jours: activiteJours.map(j => ({
                jour: j.jour, nb: j.nb, ca: Number(j.ca),
                ca_valide: Number(j.ca_valide), ca_calcule: Number(j.ca_calcule),
                nb_valides: Number(j.nb_valides), nb_refuses: Number(j.nb_refuses)
            }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const { users, devis, revenue, valides, refuses } = await avecConnexion(async (conn) => {
            await ensureV11Tables(conn);
            const [users] = await conn.query('SELECT COUNT(*) as count FROM users WHERE COALESCE(equipe_id, id) = ?', [req.userId]);
            const [devis] = await conn.query('SELECT COUNT(*) as count FROM devis WHERE user_id = ?', [req.userId]);
            // "revenue" = tous les devis chiffres, valides ou non : ce n'est pas un revenu, d'ou
            // "revenu_valide", qui ne compte que les devis devenus commandes.
            const [revenue] = await conn.query('SELECT SUM(ttc) as total FROM devis WHERE user_id = ?', [req.userId]);
            const [valides] = await conn.query(
                "SELECT COUNT(*) AS n, COALESCE(SUM(ttc), 0) AS total FROM devis WHERE user_id = ? AND statut = 'valide'", [req.userId]);
            const [refuses] = await conn.query(
                "SELECT COUNT(*) AS n FROM devis WHERE user_id = ? AND statut = 'refuse'", [req.userId]);
            return { users, devis, revenue, valides, refuses };
        });
        const tranches = Number(valides[0].n) + Number(refuses[0].n);
        res.json({
            users: users[0].count,
            devis: devis[0].count,
            revenue: revenue[0].total || 0,
            devis_valides: Number(valides[0].n),
            devis_refuses: Number(refuses[0].n),
            revenu_valide: Number(valides[0].total),
            // Calcule sur les seuls devis tranches : inclure ceux en attente ferait baisser
            // le taux a tort, alors qu'ils peuvent encore se transformer.
            taux_transformation: tranches ? Math.round((Number(valides[0].n) / tranches) * 100) : null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ROUTES FRONTEND
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/index.html')); });
app.get('/app', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/app.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/admin-dashboard.html')); });
app.get('/invitation', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/invitation.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDB();
    console.log(`✅ DropStyle API running on port ${PORT}`);
    // Verification du recapitulatif hebdomadaire toutes les 30 minutes. Le controle du
    // jour, de l'heure et du doublon est fait dans verifierRecaps.
    verifierRecaps();
    setInterval(verifierRecaps, 30 * 60 * 1000);
});

module.exports = app;
