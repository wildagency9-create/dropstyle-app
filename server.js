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

async function initDB() {
    try {
        const conn = await pool.getConnection();
        await conn.query(`CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, nom VARCHAR(255) NOT NULL, role ENUM('user', 'admin') DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS vinyles (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, name VARCHAR(255) NOT NULL, price DECIMAL(10, 2) NOT NULL, type VARCHAR(50), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS materiaux (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, support VARCHAR(255) NOT NULL, price DECIMAL(10, 2) NOT NULL, categorie VARCHAR(50), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS poseurs (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, nom VARCHAR(255) NOT NULL, jour DECIMAL(10, 2) NOT NULL, demijour DECIMAL(10, 2) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        await conn.query(`CREATE TABLE IF NOT EXISTS devis (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, qty INT NOT NULL, ht DECIMAL(10, 2) NOT NULL, ttc DECIMAL(10, 2) NOT NULL, details JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
        const [users] = await conn.query('SELECT COUNT(*) as count FROM users');
        if (users[0].count === 0) {
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await conn.query('INSERT INTO users (email, password, nom, role) VALUES (?, ?, ?, ?)', ['admin@dropstyle.com', hashedPassword, 'Admin DropStyle', 'admin']);
            const [adminUser] = await conn.query('SELECT id FROM users WHERE email = ?', ['admin@dropstyle.com']);
            const adminId = adminUser[0].id;
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, '3M Scotchprint Standard', 12.50, 'standard']);
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, '3M Scotchprint Premium', 18.00, 'premium']);
            await conn.query('INSERT INTO vinyles (user_id, name, price, type) VALUES (?, ?, ?, ?)', [adminId, 'Avery Supreme Wrapping', 14.20, 'premium']);
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'PVC 380g blanc', 15.00, 'pvc']);
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'Acrylique PMMA 3mm', 22.50, 'acrylique']);
            await conn.query('INSERT INTO materiaux (user_id, support, price, categorie) VALUES (?, ?, ?, ?)', [adminId, 'DiBond 3mm', 18.75, 'dibond']);
            await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES (?, ?, ?, ?)', [adminId, 'Jean Pose Pro', 150.00, 85.00]);
            await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES (?, ?, ?, ?)', [adminId, 'Marie Installation', 160.00, 90.00]);
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
    try { const { nom, jour, demijour } = req.body; const conn = await pool.getConnection(); await conn.query('INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES (?, ?, ?, ?)', [req.userId, nom, jour, demijour]); await conn.release(); res.status(201).json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { const { nom, jour, demijour } = req.body; const conn = await pool.getConnection(); await conn.query('UPDATE poseurs SET nom = ?, jour = ?, demijour = ? WHERE id = ? AND user_id = ?', [nom, jour, demijour, req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/tarifs/poseurs/:id', verifyToken, async (req, res) => {
    try { const conn = await pool.getConnection(); await conn.query('DELETE FROM poseurs WHERE id = ? AND user_id = ?', [req.params.id, req.userId]); await conn.release(); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// DEVIS
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
