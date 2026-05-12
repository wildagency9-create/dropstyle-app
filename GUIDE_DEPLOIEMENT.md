# 🚀 DropStyle App — GUIDE DE DÉPLOIEMENT COMPLET

---

## 📦 **STRUCTURE DES FICHIERS**

```
dropstyle-app/
├── backend/
│   ├── server.js           (Express API)
│   ├── package.json        (Dépendances Node)
│   └── .env                (Configuration - À CRÉER)
│
├── frontend/
│   ├── index.html          (Login page)
│   ├── app.html            (Calculateur)
│   └── admin-dashboard.html (Admin panel)
│
├── database/
│   └── schema.sql          (Schéma MySQL)
│
└── README.md               (Ce fichier)
```

---

## ✅ **PRÉREQUIS**

### 1. **Node.js**
```bash
# Vérifier la version (>=16)
node --version
npm --version
```

### 2. **MySQL**
```bash
# Installer MySQL Server
# macOS : brew install mysql
# Ubuntu : sudo apt-get install mysql-server
# Windows : https://dev.mysql.com/downloads/mysql/

# Vérifier
mysql --version
```

### 3. **Éditeur de texte**
- VSCode (recommandé)
- Sublime Text
- Notepad++

---

## 🔧 **INSTALLATION LOCALE**

### Step 1 : Cloner/Copier les fichiers

```bash
# Créer le dossier projet
mkdir dropstyle-app
cd dropstyle-app

# Copier tous les fichiers dans le dossier
# backend/  frontend/  database/  package.json  etc...
```

### Step 2 : Installer les dépendances Node

```bash
npm install
```

### Step 3 : Configurer la base de données

```bash
# Se connecter à MySQL
mysql -u root -p

# Lancer le schéma
mysql> source database/schema.sql;

# Vérifier que la DB est créée
mysql> SHOW DATABASES;
mysql> USE dropstyle;
mysql> SHOW TABLES;
mysql> exit
```

### Step 4 : Créer le fichier .env

```bash
# Créer fichier .env à la racine du projet
touch .env

# Contenu (adapter à votre config) :
```

**.env** (fichier)
```
DB_HOST=localhost
DB_USER=root
DB_PASS=votre_password
DB_NAME=dropstyle
JWT_SECRET=votre_secret_jwt_super_secure
PORT=3000
NODE_ENV=development
```

### Step 5 : Lancer le serveur

```bash
# En développement (avec nodemon)
npm run dev

# Ou en production
npm start
```

**Résultat :**
```
✅ DropStyle API running on http://localhost:3000
```

### Step 6 : Accéder à l'appli

```
Landing page  : http://localhost:3000/
Calculateur   : http://localhost:3000/app (après login)
Admin         : http://localhost:3000/admin (si admin)
```

**Test login:**
- Email: `admin@dropstyle.com`
- Password: `admin123`

---

## 🌐 **HÉBERGEMENT EN LIGNE**

### Option 1 : **Heroku** (gratuit/facile)

#### 1. Créer un compte Heroku
```
https://www.heroku.com/
```

#### 2. Installer Heroku CLI
```bash
# macOS
brew tap heroku/brew && brew install heroku

# Windows / Ubuntu
# https://devcenter.heroku.com/articles/heroku-cli
```

#### 3. Initialiser et déployer
```bash
# Login
heroku login

# Créer app
heroku create dropstyle-app

# Configurer variables d'environnement
heroku config:set DB_HOST=votre_db_host
heroku config:set DB_USER=votre_db_user
heroku config:set DB_PASS=votre_db_pass
heroku config:set DB_NAME=dropstyle
heroku config:set JWT_SECRET=votre_secret_jwt

# Déployer
git push heroku main

# Voir les logs
heroku logs --tail
```

**Votre app sera accessible à :**
```
https://dropstyle-app.herokuapp.com
```

---

### Option 2 : **OVH / Scaleway** (VPS classique)

#### 1. Louer un VPS
```
- OS: Ubuntu 22.04 LTS
- RAM: 2GB minimum
- Stockage: 20GB
```

#### 2. Connecter en SSH
```bash
ssh root@your_server_ip
```

#### 3. Installer les dépendances
```bash
# Update
apt update && apt upgrade -y

# Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs

# MySQL
apt install -y mysql-server

# Nginx (reverse proxy)
apt install -y nginx
```

#### 4. Cloner le projet
```bash
cd /var/www
git clone https://votre_repo.git dropstyle
cd dropstyle
npm install
```

#### 5. Configurer MySQL
```bash
mysql
> source database/schema.sql
> exit
```

#### 6. Créer .env
```bash
nano .env
# Remplir avec vos paramètres
```

#### 7. Configurer Nginx (reverse proxy)
```bash
nano /etc/nginx/sites-available/dropstyle
```

```nginx
server {
    listen 80;
    server_name votredomaine.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Activer site
ln -s /etc/nginx/sites-available/dropstyle /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

#### 8. Lancer le serveur
```bash
# Avec PM2 (supervisor)
npm install -g pm2
pm2 start server.js --name "dropstyle"
pm2 startup
pm2 save

# Vérifier
pm2 list
pm2 logs
```

---

### Option 3 : **Railway** (ultra simple)

#### 1. Aller sur Railway
```
https://railway.app
```

#### 2. Connecter GitHub et déployer
```
- Importer repo GitHub
- Railway détecte package.json
- Config vars automatiques
- Deploy en 1 clic
```

---

## 📊 **UTILISATION PROFESSIONNELLE**

### Pour les **Users** (Calculateur)

1. **Accès :** `https://votredomaine.com`
2. **Login/Register** avec email
3. **Onglet Véhicule :** Calcul rapide
4. **Onglet Signalétique :** Calcul surface
5. **Historique :** Tous les devis sauvegardés

### Pour l'**Admin**

1. **Accès :** `https://votredomaine.com/admin`
2. **Dashboard :** Stats en temps réel
3. **Gestion Users :** Créer/supprimer comptes
4. **Gestion Tarifs :** Via `tarifs/*` API

---

## 🔐 **SÉCURITÉ**

### Checklist

- ✅ `.env` en `.gitignore` (pas de push des secrets)
- ✅ JWT secret très fort (>20 caractères random)
- ✅ MySQL password fort
- ✅ HTTPS activé (Let's Encrypt gratuit)
- ✅ CORS configuré pour votre domaine uniquement

**Activer HTTPS (Let's Encrypt) :**
```bash
apt install certbot python3-certbot-nginx
certbot certonly --nginx -d votredomaine.com
```

---

## 📱 **API ENDPOINTS**

### **Auth**
```
POST   /api/auth/register
POST   /api/auth/login
```

### **Tarifs** (Nécessite token)
```
GET    /api/tarifs/vinyles
POST   /api/tarifs/vinyles
PUT    /api/tarifs/vinyles/:id
DELETE /api/tarifs/vinyles/:id

GET    /api/tarifs/materiaux
POST   /api/tarifs/materiaux
...

GET    /api/tarifs/poseurs
POST   /api/tarifs/poseurs
...
```

### **Devis** (Nécessite token)
```
POST   /api/devis
GET    /api/devis
```

### **Admin** (Nécessite token admin)
```
GET    /api/admin/users
POST   /api/admin/users
DELETE /api/admin/users/:id

GET    /api/admin/stats
```

---

## 🐛 **TROUBLESHOOTING**

### Erreur : "Connection Refused"
```
❌ MySQL n'est pas en cours d'exécution
✅ Lancer : mysql -u root -p (ou service mysql start)
```

### Erreur : "Unknown column"
```
❌ Schéma SQL pas appliqué
✅ Relancer : mysql < database/schema.sql
```

### Erreur : "CORS blocked"
```
❌ Frontend !== backend origin
✅ Vérifier server.js cors config et domaines
```

### Port 3000 déjà utilisé
```
bash
# Trouver le processus
lsof -i :3000

# Tuer le processus
kill -9 <PID>

# Ou changer le port dans .env
PORT=3001
```

---

## 📚 **FICHIERS IMPORTANTS**

| Fichier | Rôle |
|---------|------|
| `server.js` | API Express principal |
| `database/schema.sql` | Structure MySQL |
| `.env` | Variables d'environnement |
| `index.html` | Page login |
| `app.html` | Calculateur user |
| `admin-dashboard.html` | Panel admin |

---

## 🎯 **NEXT STEPS**

1. ✅ Déployer localement pour tester
2. ✅ Créer compte hébergement (Heroku/Railway/OVH)
3. ✅ Configurer domaine personnalisé
4. ✅ Activer HTTPS (Let's Encrypt)
5. ✅ Former l'équipe
6. ✅ Monitorer en prod

---

## 📞 **SUPPORT**

**Logs du serveur :**
```bash
npm run dev    # Voir errors en temps réel
heroku logs    # Sur Heroku
pm2 logs       # Avec PM2
```

**Database :**
```bash
mysql -u root -p
> USE dropstyle;
> SELECT * FROM users;
> SELECT * FROM devis;
```

---

**Dernière mise à jour :** Mai 2026  
**Status :** ✅ PRODUCTION READY
