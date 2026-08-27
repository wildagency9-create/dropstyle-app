# DropStyle — Contexte projet pour Claude Code

## Ce qu'est ce projet

DropStyle est un calculateur de devis SaaS pour une entreprise de signalétique et de marquage/covering de véhicules. Il couvre 4 catégories : marquage véhicule, panneaux signalétique, stickers (avec optimisation de laize) et impressions sous-traitées Exaprint. Objectif : des devis fiables, calibrés sur les factures réelles de l'entreprise (cible : écart ±10 % vs historique).

## Règles de travail (importantes)

- **Toujours répondre et commenter en français.**
- **Développement additif uniquement** : ne jamais réécrire un module qui fonctionne. Les nouvelles fonctionnalités sont des couches ajoutées au code existant.
- **Tout paramètre de prix doit être modifiable via l'admin** (jamais codé en dur dans les calculs).
- L'utilisateur n'est pas développeur : expliquer les changements simplement, proposer un aperçu avant les gros chantiers, valider chaque diff.
- Déploiement : un push sur la branche principale GitHub déclenche automatiquement le redéploiement Railway (https://dropstyle-app-production.up.railway.app/).

## Architecture

- **Backend** : Node.js/Express — `server.js` à la racine. MySQL (pool mysql2/promise), tables créées au démarrage dans `initDB()` (idempotent). Auth JWT (`verifyToken`).
- **Frontend** : vanilla HTML/CSS/JS dans `frontend/` — `app.html` (interface de devis `/app`), `admin-dashboard.html` (`/admin`), page de connexion.
- **Tables** : users, vinyles, materiaux (panneaux), laminations, tapes, poseurs (colonne `type_prix` : 'vente' ou 'cout'), impressions (grille Exaprint), devis, parametres (clé/valeur), forfaits.
- Compte admin de démo : admin@dropstyle.com.

## Le moteur de prix (cœur du projet)

Logique validée par l'entreprise via un classeur Excel/Google Sheets (codes P01–P24) :

1. **Lignes COÛT** (matière : vinyle, lamination, impression numérique P23, tape, panneau) → déboursé sec **× coefficient P01** (défaut ×2).
2. **Lignes VENTE** (pose P18–P20, PAO P16/P17, échenillage/découpe au taux P21, forfaits) → ajoutées telles quelles. Exception : poseur `type_prix='cout'` → coût × P24.
3. Puis dans l'ordre : × majoration délai (P06 urgent / P07 express) → + frais de dossier P04 → minimum de commande P03 → arrondi commercial P05 (multiple supérieur) → TVA P02.
4. Véhicule : surface facturable (grille validée : citadine 20 m² total, berline 25, SUV 28, utilitaire 25, fourgon 40, camion 35) × coefficient de chute P10 (×1,25, surfaces HORS chutes). Mode forfait alternatif (table `forfaits`, remplace matière+pose+PAO).
5. La fonction `computeTotal()` dans `app.html` centralise la totalisation — toute nouvelle catégorie de produit doit passer par elle.

Références de calibration : Partner Long M covering complet = 3 670 € HT réels (moteur : ~3 625 €, 25 m², polymère 3,30 + impression 12 + lamination 2,83, 4 j pose, PAO forfait). Kangoo semi-covering = 1 092 € HT réels.

## Synchronisation Google Sheets

- Le classeur « DropStyle moteur validation » (ID dans `SHEETS_ID`, env `SHEETS_ID` sur Railway) est la source de vérité des paramètres P01–P24 et des tarifs matière.
- Lecture via gviz CSV (`headers=0`), parseur **piloté par les en-têtes de colonnes** (tolère les restructurations). Endpoints : `GET /api/sync-sheets/preview` (diff) et `POST /api/sync-sheets/apply`.
- Bouton 🔄 dans l'admin, onglet ⚙️ Moteur. L'onglet 📖 Tarifs de `/app` affiche les données pour vérification.
- Ne pas casser la tolérance du parseur : sections détectées par titres pluriels (VINYLES, LAMINATIONS, TAPES, MATÉRIAUX), colonnes repérées par mots-clés (prix/valid/laize/format).

## Backlog connu

- Calibration des ~13 factures historiques dans la feuille « Calibration » (objectif ±10 %) ; envisager un onglet 🎯 Calibration dans l'admin.
- Tiers clients (Standard/Premium) — prévu, non implémenté.
- Modification d'un devis depuis l'onglet Historique.
- Sélecteur silhouette SVG véhicule (10 types, zones cliquables orange #D85A30) — EN PAUSE, ne pas utiliser les fichiers CCVision (licence interdite en intégration logicielle).
- Possibles coefficients par catégorie (le ×2 unique surestime peut-être les grandes séries de stickers — réf. historique 2,94 €/u).

## Pièges connus

- `initDB()` : chaque évolution de schéma doit être idempotente (CREATE IF NOT EXISTS, ALTER dans try/catch) — la base existe déjà en production.
- Les prix en base sont des **prix d'achat** pour vinyles/laminations/tapes/panneaux (multipliés par P01) ; pose/PAO/forfaits sont des **prix de vente**. Ne jamais mélanger.
- La synchro Sheets REMPLACE le contenu des tables vinyles/laminations/tapes/materiaux pour l'utilisateur : les ajouts manuels dans ces tables sont écrasés à la synchro suivante.
