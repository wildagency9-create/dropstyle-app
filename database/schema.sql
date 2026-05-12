-- database/schema.sql
-- Base de données DropStyle

CREATE DATABASE IF NOT EXISTS dropstyle;
USE dropstyle;

-- ========================================
-- TABLE UTILISATEURS
-- ========================================
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    nom VARCHAR(255) NOT NULL,
    role ENUM('user', 'admin') DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE INDEX idx_email ON users(email);

-- ========================================
-- TABLE VINYLES (Par utilisateur)
-- ========================================
CREATE TABLE vinyles (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    type ENUM('standard', 'premium', 'special') DEFAULT 'standard',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id)
);

-- ========================================
-- TABLE MATÉRIAUX (Par utilisateur)
-- ========================================
CREATE TABLE materiaux (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    support VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    categorie ENUM('pvc', 'acrylique', 'dibond', 'aluminium', 'autre') DEFAULT 'pvc',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id)
);

-- ========================================
-- TABLE POSEURS (Par utilisateur)
-- ========================================
CREATE TABLE poseurs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    nom VARCHAR(255) NOT NULL,
    jour DECIMAL(10, 2) NOT NULL,
    demijour DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id)
);

-- ========================================
-- TABLE DEVIS (Historique)
-- ========================================
CREATE TABLE devis (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    type ENUM('vehicule', 'signaletique') NOT NULL,
    qty INT NOT NULL,
    ht DECIMAL(10, 2) NOT NULL,
    ttc DECIMAL(10, 2) NOT NULL,
    details JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_date (user_id, created_at)
);

-- ========================================
-- DONNÉES PAR DÉFAUT
-- ========================================

-- Admin user (password: admin123)
INSERT INTO users (email, password, nom, role) VALUES (
    'admin@dropstyle.com',
    '$2b$10$YourBcryptHashHere',
    'Admin DropStyle',
    'admin'
);

-- Exemple vinyles pour admin (user_id = 1)
INSERT INTO vinyles (user_id, name, price, type) VALUES 
(1, '3M Scotchprint Standard', 12.50, 'standard'),
(1, '3M Scotchprint Premium', 18.00, 'premium'),
(1, 'Avery Supreme Wrapping', 14.20, 'premium');

-- Exemple matériaux
INSERT INTO materiaux (user_id, support, price, categorie) VALUES
(1, 'PVC 380g blanc', 15.00, 'pvc'),
(1, 'Acrylique PMMA 3mm', 22.50, 'acrylique'),
(1, 'DiBond 3mm', 18.75, 'dibond');

-- Exemple poseurs
INSERT INTO poseurs (user_id, nom, jour, demijour) VALUES
(1, 'Jean Pose Pro', 150.00, 85.00),
(1, 'Marie Installation', 160.00, 90.00);
