# 🎨 DropStyle — Calculateur de Prix Pro Complet

**Version:** 2.0 (Full Stack)  
**Status:** ✅ Production Ready  
**Tech Stack:** Node.js + Express + MySQL + JWT Auth  

---

## 📋 **APERÇU**

DropStyle est une **application SaaS professionnelle** complète pour :
- ✅ Calculer des devis (Véhicule + Signalétique)
- ✅ Gérer ses tarifs (Vinyles, Matériaux, Poseurs)
- ✅ Historique des devis (Sauvegarde auto)
- ✅ Multi-utilisateurs avec authentification JWT
- ✅ Dashboard admin avec stats en temps réel
- ✅ Gestion complète des utilisateurs

---

## 🎯 **CAS D'USAGE**

| Acteur | Utilisation |
|--------|-----------|
| **Vendeur** | Calcule devis client, sauvegarde, exporte CSV |
| **Manager** | Voit stats (devis/revenue), crée comptes poseurs |
| **Admin** | Gère utilisateurs, configure tarifs globaux |

---

## 🏗️ **ARCHITECTURE**

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (HTML/CSS/JS)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Login    │  │Calculator│  │Admin     │             │
│  │index.html│  │app.html  │  │dashboard │             │
│  └──────────┘  └──────────┘  └──────────┘             │
└────────────────────────────────────────────────────────┘
                          ↓ (HTTP + JWT)
┌─────────────────────────────────────────────────────────┐
│              BACKEND API (Express.js)                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │  /api/auth/*           (Login/Register)        │   │
│  │  /api/tarifs/*         (CRUD Vinyles, etc)    │   │
│  │  /api/devis            (Sauvegarde devis)     │   │
│  │  /api/admin/*          (Dashboard + Users)     │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
                          ↓ (SQL Queries)
┌─────────────────────────────────────────────────────────┐
│              DATABASE (MySQL)                          │
│  ┌────────┐  ┌──────────┐  ┌─────────┐  ┌────────┐   │
│  │ users  │  │ vinyles  │  │materials│  │ devis  │   │
│  │ poseurs│  │ ...      │  │ poseurs │  │ ...    │   │
│  └────────┘  └──────────┘  └─────────┘  └────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 📦 **CONTENU DU PACKAGE**

### Backend
- `server.js` — API Express avec JWT auth
- `database/schema.sql` — Structure MySQL complète
- `package.json` — Dépendances Node.js

### Frontend
- `index.html` — Page login/register
- `app.html` — Calculateur pour users
- `admin-dashboard.html` — Panel admin

### Documentation
- `GUIDE_DEPLOIEMENT.md` — Installation & déploiement
- Ce README

---

## 🚀 **DÉMARRAGE RAPIDE**

### En Local (5 min)

```bash
# 1. Installer dépendances
npm install

# 2. Créer base de données
mysql < database/schema.sql

# 3. Créer .env
echo "DB_HOST=localhost" > .env
echo "DB_USER=root" >> .env
echo "DB_PASS=" >> .env
echo "DB_NAME=dropstyle" >> .env

# 4. Lancer serveur
npm run dev

# 5. Accéder
# → http://localhost:3000
# Login : admin@dropstyle.com / admin123
```

---

## 📚 **DOCUMENTATION DÉTAILLÉE**

| Document | Contenu |
|----------|---------|
| **GUIDE_DEPLOIEMENT.md** | Déploiement local, Heroku, OVH, Railway, troubleshooting |
| **RAPPORT_DROPSTYLE.md** | Tests, bugs fixes, recommendations (ancienne version) |
| **CHANGELOG.md** | Historique features (ancienne version) |
| **AMELIORATIONS.md** | Détails techniques (ancienne version) |

---

## 🎨 **FEATURES**

### ✅ Calculateur Véhicule
```
Type de véhicule (6 options)
  ↓
Choix du vinyle (basé sur tarifs)
  ↓
Quantité + Délai (normal/urgent/express)
  ↓
Prix HT/TTC automatique
  ↓
Sauvegarde en base
```

### ✅ Calculateur Signalétique
```
Support (Panneau, Vitrophanie, etc)
  ↓
Dimensions (cm) → Calcul m²
  ↓
Matériau (PVC, Acrylique, DiBond)
  ↓
Prix HT/TTC automatique
```

### ✅ Gestion Tarifs (Admin)
```
Vinyles          → CRUD + Import Excel
Matériaux        → CRUD + Import Excel
Poseurs          → Jour/Demi-jour rates
```

### ✅ Admin Dashboard
```
Stats en temps réel (Users / Devis / Revenue)
Gestion utilisateurs (Créer/Supprimer)
Édition tarifs globaux
```

---

## 🔐 **Authentification & Sécurité**

### JWT Token
```
Login → Token généré → Stocké en localStorage
→ Envoyé dans header Authorization de chaque requête
→ Vérification côté serveur pour protéger les routes
```

### Rôles
```
user  → Accès calculateur + historique
admin → Accès dashboard + gestion users
```

### Password
```
Bcrypt hash (10 rounds) stocké en base
Jamais en plaintext
```

---

## 💾 **Base de Données**

### Tables
```
users        (id, email, password, nom, role)
vinyles      (id, user_id, name, price, type)
materiaux    (id, user_id, support, price, categorie)
poseurs      (id, user_id, nom, jour, demijour)
devis        (id, user_id, type, qty, ht, ttc, details, created_at)
```

### Multi-Tenant
```
Chaque user voit UNIQUEMENT ses vinyles/matériaux/devis
user_id = clé étrangère dans toutes les tables
```

---

## 🌐 **Déploiement**

### Développement
```bash
npm run dev     # Avec nodemon (auto-reload)
```

### Production
```bash
npm start       # Node simple
# ou PM2 (supervisor)
pm2 start server.js
```

### Sur Heroku
```bash
heroku create dropstyle
heroku config:set DB_HOST=...
git push heroku main
```

### Sur VPS (OVH/Scaleway)
```
1. SSH into VPS
2. Clone repo
3. npm install
4. Configurer MySQL
5. Configurer Nginx (reverse proxy port 3000)
6. Lancer avec PM2
```

**→ Voir GUIDE_DEPLOIEMENT.md pour détails complets**

---

## 📊 **API Endpoints**

### Auth (Public)
```
POST /api/auth/register    {email, password, nom}
POST /api/auth/login       {email, password} → token
```

### Tarifs (Protected)
```
GET    /api/tarifs/vinyles
POST   /api/tarifs/vinyles
PUT    /api/tarifs/vinyles/:id
DELETE /api/tarifs/vinyles/:id
(idem pour /materiaux et /poseurs)
```

### Devis (Protected)
```
POST /api/devis     {type, qty, ht, ttc, details}
GET  /api/devis     → Liste devis user
```

### Admin (Protected + Admin Only)
```
GET    /api/admin/users
POST   /api/admin/users     {email, password, nom, role}
DELETE /api/admin/users/:id

GET    /api/admin/stats     → {users, devis, revenue}
```

---

## 🎓 **Workflows Typiques**

### Workflow 1 : User calcule un devis
```
1. Login → app.html
2. Sélectionne Véhicule ou Signalétique
3. Remplit champs
4. Clic "Calculer"
5. Voit résultat HT/TTC
6. Automatiquement sauvegardé en base
7. Peut revenir plus tard (Historique)
```

### Workflow 2 : Admin ajoute un utilisateur
```
1. Login → admin-dashboard.html
2. Voir stats (Users, Devis, Revenue)
3. Clic "+ Ajouter utilisateur"
4. Remplir formulaire (email, nom, rôle)
5. Nouveau user peut login
```

### Workflow 3 : Manager met à jour les tarifs
```
1. Login → app.html (si user) ou admin-dashboard
2. Accès aux tarifs via API
3. Modifier via interface
4. Les nouveaux calculs utilisent les tarifs mis à jour
```

---

## 🐛 **Common Issues**

| Erreur | Solution |
|--------|----------|
| MySQL connection failed | Vérifier MySQL running + .env config |
| CORS error | Vérifier server.js cors() config |
| Token expired | Re-login pour nouveau token |
| 404 /app | Vérifier token valide + répertoire frontend |

---

## 🚀 **Prochaines Features Recommendations**

- [ ] Export PDF devis
- [ ] Multi-devis (panier)
- [ ] Remise client %
- [ ] Templates devis
- [ ] Webhooks (notifications)
- [ ] Mobile app (React Native)
- [ ] Intégration CRM
- [ ] Analytics avancées

---

## 📝 **Configuration .env**

```env
# Database
DB_HOST=localhost
DB_USER=root
DB_PASS=votre_password
DB_NAME=dropstyle

# API
PORT=3000
NODE_ENV=development

# JWT
JWT_SECRET=votre_secret_jwt_tres_securise_min_20_chars

# CORS (optionnel, par défaut tout domaine)
CORS_ORIGIN=http://localhost:3000
```

---

## 📞 **Support & Issues**

### Logs
```bash
# Développement
npm run dev

# Production (PM2)
pm2 logs dropstyle

# Heroku
heroku logs --tail
```

### Database Debug
```bash
mysql -u root -p dropstyle
> SHOW TABLES;
> SELECT * FROM users;
> SELECT COUNT(*) FROM devis;
```

---

## 📄 **Licence**

Propriétaire DropStyle © 2026

---

## 🎉 **Démarrage**

```bash
# 1. Cloner ou copier fichiers
git clone <repo> dropstyle-app
cd dropstyle-app

# 2. Installer & configurer
npm install
mysql < database/schema.sql
cp .env.example .env  # Adapter values

# 3. Lancer
npm run dev

# 4. Profiter ! 🚀
# http://localhost:3000
```

---

**Questions ?** Voir les autres fichiers de documentation.  
**Prêt à déployer ?** Suivre GUIDE_DEPLOIEMENT.md  
**Version ancienne ?** Voir RAPPORT_DROPSTYLE.md  

---

**Dernière mise à jour:** Mai 2026  
**Made with ❤️ by Claude + DropStyle Team**
