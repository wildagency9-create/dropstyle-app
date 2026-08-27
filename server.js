const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const mysql = require('mysql2/promise');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());
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

// V6 — creation idempotente des tables/colonnes du moteur unifie.
// Chaque requete est independante : un echec n'empeche pas les suivantes, et la fonction
// est rappelee par les endpoints concernes, donc les tables finissent toujours par exister.
async function ensureV6Tables(existingConn) {
    const conn = existingConn || await pool.getConnection();
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
    if (!existingConn) await conn.release();
}

async function initDB() {
    try {
        const conn = await pool.getConnection();
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
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [adminId, 'pao_horaire', 75.00]);

            // V5 — Forfaits vehicule (depuis historique)
            await conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Petit semi-covering', 1092.00]);
            await conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [adminId, 'Partner Long M (complet)', 3670.00]);
        }
        await conn.release();
    } catch (err) {
        console.error('DB Error:', err.message);
    }
}

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    const jwt = require('jsonwebtoken');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
        req.userId = decoded.id;
        req.userRole = decoded.role;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Token invalide' });
    }
};

// AUTH
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, nom } = req.body;
        const bcrypt = require('bcrypt');
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
        if (rows.length > 0) { await conn.release(); return res.status(400).json({ error: 'Email déjà utilisé' }); }
        const hashedPassword = await bcrypt.hash(password, 10);
        await conn.query('INSERT INTO users (email, password, nom, role) VALUES (?, ?, ?, ?)', [email, hashedPassword, nom, 'user']);
        await conn.release();
        res.status(201).json({ message: 'Utilisateur créé' });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const bcrypt = require('bcrypt');
        const jwt = require('jsonwebtoken');
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT * FROM users WHERE email = ?', [email]);
        await conn.release();
        if (rows.length === 0) return res.status(401).json({ error: 'Identifiants invalides' });
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'secret123', { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, nom: user.nom, role: user.role } });
    } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// VINYLES CRUD
app.get('/api/tarifs/vinyles', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM vinyles WHERE user_id = ?', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/vinyles', verifyToken, async (req, res) => {
    try { const { name, price, type } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [req.userId, name, price, type]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/vinyles/:id', verifyToken, async (req, res) => {
    try { const { name, price, type } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE vinyles SET name = ?, price = ?, type = ? WHERE id = ? AND user_id = ?', [name, price, type, req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/vinyles/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM vinyles WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// MATERIAUX CRUD
app.get('/api/tarifs/materiaux', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM materiaux WHERE user_id = ?', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/materiaux', verifyToken, async (req, res) => {
    try { const { support, price, categorie } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [req.userId, support, price, categorie]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/materiaux/:id', verifyToken, async (req, res) => {
    try { const { support, price, categorie } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE materiaux SET support = ?, price = ?, categorie = ? WHERE id = ? AND user_id = ?', [support, price, categorie, req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/materiaux/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM materiaux WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// POSEURS CRUD
app.get('/api/tarifs/poseurs', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM poseurs WHERE user_id = ?', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/poseurs', verifyToken, async (req, res) => {
    try { const { nom, jour, demijour, type_prix } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour, type_prix) VALUES (?, ?, ?, ?, ?)', [req.userId, nom, jour, demijour, type_prix || 'vente']); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { const { nom, jour, demijour } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE poseurs SET nom = ?, jour = ?, demijour = ?, type_prix = ? WHERE id = ? AND user_id = ?', [nom, jour, demijour, req.body.type_prix || 'vente', req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM poseurs WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPRESSIONS CRUD
app.get('/api/tarifs/impressions', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM impressions WHERE user_id = ? ORDER BY type, format, grammage, finition, quantite', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/impressions', verifyToken, async (req, res) => {
    try { const { type, format, grammage, finition, quantite, prix_exa } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO impressions (user_id, type, format, grammage, finition, quantite, prix_exa) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.userId, type, format, grammage, finition, quantite, prix_exa]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/impressions/:id', verifyToken, async (req, res) => {
    try { const { type, format, grammage, finition, quantite, prix_exa } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE impressions SET type = ?, format = ?, grammage = ?, finition = ?, quantite = ?, prix_exa = ? WHERE id = ? AND user_id = ?', [type, format, grammage, finition, quantite, prix_exa, req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/impressions/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM impressions WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// V5 — PARAMETRES MOTEUR (cle/valeur)
// V6 — Parametres complets du moteur (codes P01-P24 du classeur de validation)
const DEFAULT_PARAMS = {
    coefficient: 2.00,           // P01 - multiplicateur du debourse sec matiere
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
    pao_horaire: 75.00,          // P17 - vente directe
    pose_atelier_jour: 525.00,   // P18 - vente directe
    pose_atelier_demi: 300.00,   // P19 - vente directe
    pose_site_point: 300.00,     // P20 - vente directe
    taux_horaire_atelier: 60.00, // P21 - echenillage, decoupe, finitions
    coef_impression: 2.00,       // P22 - marge sur prix Exaprint
    impression_m2: 12.00,        // P23 - cout encre + machine (valide 10-15 €)
    coef_pose_st: 1.30           // P24 - majoration cout poseur sous-traitant
};
app.get('/api/parametres', verifyToken, async (req, res) => {
    try {
        const conn = await pool.getConnection();
let [rows] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
        const have = new Set(rows.map(r => r.cle));
        let added = false;
        for (const [cle, valeur] of Object.entries(DEFAULT_PARAMS)) {
            if (!have.has(cle)) { await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?)', [req.userId, cle, valeur]); added = true; }
        }
        if (added) [rows] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
        await conn.release();
        const obj = {};
        rows.forEach(r => { obj[r.cle] = parseFloat(r.valeur); });
        res.json(obj);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/parametres', verifyToken, async (req, res) => {
    try {
        const updates = req.body || {};
        const conn = await pool.getConnection();
        for (const [cle, valeur] of Object.entries(updates)) {
            await conn.query('INSERT INTO parametres (user_id, cle, valeur) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valeur = ?', [req.userId, cle, valeur, valeur]);
        }
        await conn.release();
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// V5 — FORFAITS VEHICULE CRUD
app.get('/api/tarifs/forfaits', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM forfaits WHERE user_id = ? ORDER BY prix', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tarifs/forfaits', verifyToken, async (req, res) => {
    try { const { nom, prix } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO forfaits (user_id, nom, prix) VALUES (?, ?, ?)', [req.userId, nom, prix]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/forfaits/:id', verifyToken, async (req, res) => {
    try { const { nom, prix } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE forfaits SET nom = ?, prix = ? WHERE id = ? AND user_id = ?', [nom, prix, req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/forfaits/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM forfaits WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// DEVIS
// ===== V6 — LAMINATIONS & TAPES =====
app.get('/api/tarifs/laminations', verifyToken, async (req, res) => {
    try { await ensureV6Tables(); const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM laminations WHERE user_id = ? ORDER BY prix', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/tarifs/tapes', verifyToken, async (req, res) => {
    try { await ensureV6Tables(); const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM tapes WHERE user_id = ? ORDER BY prix', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
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
    const base = `https://docs.google.com/spreadsheets/d/${SHEETS_ID}/gviz/tq?tqx=out:csv&sheet=`;
    const [csvParams, csvTarifs] = await Promise.all([
        httpGet(base + encodeURIComponent('Paramètres')),
        httpGet(base + encodeURIComponent('Tarifs matières'))
    ]);
    if (csvParams.trimStart().startsWith('<')) throw new Error('ACCES');
    // Parametres : ligne dont la colonne A = P01..P24, valeur retenue en colonne E (repli D puis C)
    const parametres = {};
    for (const row of parseCSV(csvParams)) {
        const code = (row[0] || '').trim();
        if (/^P\d{2}$/.test(code) && SHEET_PARAM_MAP[code]) {
            const val = cleanNum(row[4]) ?? cleanNum(row[3]) ?? cleanNum(row[2]);
            if (val !== null) parametres[SHEET_PARAM_MAP[code]] = val;
        }
    }
    // Tarifs : sections VINYLES / LAMINATIONS / TAPES / MATERIAUX PANNEAUX
    const tables = { vinyles: [], laminations: [], tapes: [], materiaux: [] };
    let current = null, skipHeader = false;
    for (const row of parseCSV(csvTarifs)) {
        const a = (row[0] || '').trim();
        const aU = a.toUpperCase();
        if (aU.startsWith('VINYLES')) { current = 'vinyles'; skipHeader = true; continue; }
        if (aU.startsWith('LAMINATION')) { current = 'laminations'; skipHeader = true; continue; }
        if (aU.startsWith('TAPES')) { current = 'tapes'; skipHeader = true; continue; }
        if (aU.startsWith('MATÉRIAUX') || aU.startsWith('MATERIAUX')) { current = 'materiaux'; skipHeader = true; continue; }
        if (aU.startsWith('QUESTION')) { current = null; continue; }
        if (!current) continue;
        if (skipHeader) { skipHeader = false; continue; }
        if (!a || a.startsWith('(')) continue;
        const prix = cleanNum(row[2]) ?? cleanNum(row[1]);
        if (prix === null) continue;
        tables[current].push({ nom: a, prix, laizes: (row[3] || '').trim() });
    }
    return { parametres, tables };
}

app.get('/api/sync-sheets/preview', verifyToken, async (req, res) => {
    try {
        await ensureV6Tables();
        const data = await fetchSheetsData();
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT cle, valeur FROM parametres WHERE user_id = ?', [req.userId]);
        const [vin] = await conn.query('SELECT COUNT(*) AS n FROM vinyles WHERE user_id = ?', [req.userId]);
        const [lam] = await conn.query('SELECT COUNT(*) AS n FROM laminations WHERE user_id = ?', [req.userId]);
        const [tap] = await conn.query('SELECT COUNT(*) AS n FROM tapes WHERE user_id = ?', [req.userId]);
        const [mat] = await conn.query('SELECT COUNT(*) AS n FROM materiaux WHERE user_id = ?', [req.userId]);
        await conn.release();
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
        const conn = await pool.getConnection();
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
        await conn.release();
        res.json({ message: 'Synchronisation appliquée', parametres: Object.keys(data.parametres).length, vinyles: data.tables.vinyles.length, laminations: data.tables.laminations.length, tapes: data.tables.tapes.length, materiaux: data.tables.materiaux.length });
    } catch (err) {
        if (err.message === 'ACCES' || /^HTTP (401|403|404)/.test(err.message)) return res.status(502).json({ error: 'Accès refusé au Google Sheets — vérifier le partage : « Toute personne disposant du lien : Lecteur ».' });
        res.status(500).json({ error: 'Synchronisation impossible : ' + err.message });
    }
});

app.post('/api/devis', verifyToken, async (req, res) => {
    try { const { type, qty, ht, ttc, details } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO devis (user_id, type, qty, ht, ttc, details, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())', [req.userId, type, qty, ht, ttc, JSON.stringify(details)]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/devis', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); const [rows] = await conn.query('SELECT * FROM devis WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.userId]); await conn.release(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ADMIN
app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT id, email, nom, role, created_at FROM users');
        await conn.release();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/users', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const { email, password, nom, role } = req.body;
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(password, 10);
        const conn = await pool.getConnection();
        await conn.query('INSERT INTO users (email, password, nom, role) VALUES (?, ?, ?, ?)', [email, hashedPassword, nom, role]);
        await conn.release();
        res.status(201).json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const conn = await pool.getConnection();
        await conn.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        await conn.release();
        res.json({ message: 'OK' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/stats', verifyToken, async (req, res) => {
    try {
        if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
        const conn = await pool.getConnection();
        const [users] = await conn.query('SELECT COUNT(*) as count FROM users');
        const [devis] = await conn.query('SELECT COUNT(*) as count FROM devis');
        const [revenue] = await conn.query('SELECT SUM(ttc) as total FROM devis');
        await conn.release();
        res.json({ users: users[0].count, devis: devis[0].count, revenue: revenue[0].total || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ROUTES FRONTEND
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/index.html')); });
app.get('/app', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/app.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'frontend/admin-dashboard.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDB();
    console.log(`✅ DropStyle API running on port ${PORT}`);
});

module.exports = app;
