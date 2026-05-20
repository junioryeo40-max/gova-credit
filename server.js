// Chargement des variables d'environnement depuis .env
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// INITIALISATION FIREBASE
// La clé privée contient des \n qu'on doit convertir en vrais sauts de ligne
// ============================================================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
});

const db = admin.firestore();

// ============================================================
// MIDDLEWARES
// ============================================================
app.use(cors()); // Autorise les requêtes depuis le frontend Vercel
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Sert les fichiers HTML

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

// Arrondit un montant au 10 FCFA supérieur (ex: 1072 → 1080)
function arrondiAuDixSuperieur(montant) {
  return Math.ceil(montant / 10) * 10;
}

// Génère un identifiant de transaction unique basé sur le timestamp
function genererTransactionId() {
  const timestamp = Date.now();
  const aleatoire = Math.random().toString(36).substr(2, 8).toUpperCase();
  return `TXN-${timestamp}-${aleatoire}`;
}

// Nettoie le numéro de téléphone : retire le préfixe +225, 00225 ou 225
function nettoyerNumero(telephone) {
  return telephone.replace(/^(\+225|00225|225)/, '').replace(/\s/g, '');
}

// ============================================================
// ROUTE 1 : INITIER UN PAIEMENT
// POST /initier-paiement
// Reçoit : { telephone, operateur, montant }
// Retourne : { succes, payment_url, transactionId, montantFacture }
// ============================================================
app.post('/initier-paiement', async (req, res) => {
  try {
    const { telephone, operateur, montant } = req.body;

    // --- Validation des données reçues du frontend ---
    if (!telephone || !operateur || !montant) {
      return res.status(400).json({
        succes: false,
        message: 'Données manquantes : téléphone, opérateur et montant sont requis.',
      });
    }

    const montantDemande = parseInt(montant);

    if (isNaN(montantDemande) || montantDemande < 100) {
      return res.status(400).json({
        succes: false,
        message: 'Le montant minimum est de 100 FCFA.',
      });
    }

    if (!['MOOV', 'MTN', 'ORANGE'].includes(operateur.toUpperCase())) {
      return res.status(400).json({
        succes: false,
        message: "Opérateur invalide. Choisissez MOOV, MTN ou ORANGE.",
      });
    }

    // --- Calcul du montant à facturer avec commission 7% ---
    const montantFacture = arrondiAuDixSuperieur(montantDemande * 1.07);
    const commission = montantFacture - montantDemande;

    // --- Génération d'un ID unique pour cette transaction ---
    const transactionId = genererTransactionId();

    // --- Sauvegarde préalable dans Firebase avec statut "en_attente" ---
    // On sauvegarde AVANT d'appeler CinetPay pour garder une trace de chaque tentative
    await db.collection('transactions').doc(transactionId).set({
      transactionId,
      telephone: telephone.trim(),
      operateur: operateur.toUpperCase(),
      montantDemande,
      montantFacture,
      commission,
      statut: 'en_attente',
      dateCreation: admin.firestore.FieldValue.serverTimestamp(),
    });

    // --- Appel API CinetPay pour créer la transaction de paiement ---
    const reponseCinetpay = await axios.post(
      'https://api-checkout.cinetpay.com/v2/payment',
      {
        apikey: process.env.CINETPAY_API_KEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: transactionId,
        amount: montantFacture,
        currency: 'XOF',
        description: `${montantDemande} FCFA d'unités ${operateur} → ${telephone}`,
        // URL de retour après paiement (page de confirmation côté frontend)
        return_url: `${process.env.FRONTEND_URL}/success.html`,
        // URL que CinetPay appellera automatiquement après paiement réussi
        notify_url: `${process.env.BACKEND_URL}/webhook-cinetpay`,
        customer_name: 'Client',
        customer_surname: 'Cabine',
        customer_email: 'client@cabine-transfert.ci',
        customer_phone_number: telephone.trim(),
        customer_address: 'Abidjan',
        customer_city: 'Abidjan',
        customer_country: 'CI',
        customer_state: 'CI',
        customer_zip_code: '00225',
        channels: 'ALL', // Accepte tous les modes de paiement (MoMo, Wave, etc.)
        lang: 'fr',
        // Métadonnées : stockées par CinetPay et renvoyées dans le webhook
        metadata: JSON.stringify({ telephone, operateur, montantDemande }),
      }
    );

    // --- Vérification de la réponse CinetPay ---
    // Code "201" = transaction créée avec succès
    if (reponseCinetpay.data.code !== '201') {
      console.error('Erreur CinetPay initiation:', reponseCinetpay.data);

      // Mise à jour du statut dans Firebase
      await db.collection('transactions').doc(transactionId).update({
        statut: 'erreur_creation',
        erreur: reponseCinetpay.data.message || 'Erreur CinetPay inconnue',
      });

      return res.status(500).json({
        succes: false,
        message: "Impossible de créer le paiement. Veuillez réessayer.",
      });
    }

    // --- Succès : on retourne le lien de paiement au frontend ---
    res.json({
      succes: true,
      payment_url: reponseCinetpay.data.data.payment_url,
      transactionId,
      montantFacture,
    });

  } catch (erreur) {
    console.error('Erreur /initier-paiement:', erreur.message);
    res.status(500).json({
      succes: false,
      message: "Erreur serveur. Veuillez réessayer dans quelques instants.",
    });
  }
});

// ============================================================
// ROUTE 2 : WEBHOOK CINETPAY (confirmation de paiement)
// POST /webhook-cinetpay
// Appelé automatiquement par CinetPay après un paiement réussi
// ============================================================
app.post('/webhook-cinetpay', async (req, res) => {
  // On répond toujours 200 rapidement à CinetPay pour éviter les retentatives
  // Le traitement réel se fait de manière asynchrone
  res.status(200).json({ message: 'Webhook reçu' });

  try {
    const { cpm_trans_id } = req.body;

    console.log(`\n📨 Webhook CinetPay reçu pour transaction: ${cpm_trans_id}`);
    console.log('Données reçues:', JSON.stringify(req.body, null, 2));

    if (!cpm_trans_id) {
      console.error('Webhook sans transaction_id, ignoré.');
      return;
    }

    // --- ÉTAPE 1 : Vérification du paiement auprès de l'API CinetPay ---
    // On ne fait jamais confiance aux données du webhook directement.
    // On vérifie toujours auprès de CinetPay que le paiement est bien réel.
    const verification = await axios.post(
      'https://api-checkout.cinetpay.com/v2/payment/check',
      {
        apikey: process.env.CINETPAY_API_KEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: cpm_trans_id,
      }
    );

    const dataVerif = verification.data?.data;
    console.log('Résultat vérification CinetPay:', verification.data.code, dataVerif?.status);

    // Si le paiement n'est pas ACCEPTED, on arrête tout
    if (verification.data.code !== '00' || dataVerif?.status !== 'ACCEPTED') {
      console.log(`❌ Paiement non accepté pour ${cpm_trans_id} - Statut: ${dataVerif?.status}`);
      return;
    }

    // --- ÉTAPE 2 : Anti-double envoi ---
    // On vérifie dans Firebase que cette transaction n'a pas déjà été traitée.
    // Cela protège contre les webhooks envoyés plusieurs fois par CinetPay.
    const transactionRef = db.collection('transactions').doc(cpm_trans_id);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
      console.error(`Transaction ${cpm_trans_id} introuvable dans Firebase.`);
      return;
    }

    const transaction = transactionDoc.data();

    // Si la transaction est déjà marquée comme complète ou en cours de transfert,
    // on ne fait rien pour éviter un double envoi d'unités.
    if (['complete', 'transfert_envoye', 'paiement_recu'].includes(transaction.statut)) {
      console.log(`⚠️ Transaction ${cpm_trans_id} déjà traitée (${transaction.statut}). Aucun doublon.`);
      return;
    }

    const { telephone, operateur, montantDemande } = transaction;

    // --- ÉTAPE 3 : Marquer le paiement comme reçu avant le transfert ---
    await transactionRef.update({
      statut: 'paiement_recu',
      datePaiement: admin.firestore.FieldValue.serverTimestamp(),
      montantVerifie: dataVerif.amount,
    });

    // --- ÉTAPE 4 : Envoi des unités via l'API transfert CinetPay ---
    console.log(`📤 Envoi de ${montantDemande} FCFA d'unités ${operateur} vers ${telephone}...`);

    const numeroNettoye = nettoyerNumero(telephone);

    const transfert = await axios.post(
      'https://client.cinetpay.com/v1/transfer/money/send/contact',
      {
        apikey: process.env.CINETPAY_API_KEY,
        password: process.env.CINETPAY_TRANSFER_PASSWORD,
        prefix: '225', // Indicatif téléphonique de la Côte d'Ivoire
        phone: numeroNettoye,
        amount: montantDemande, // On envoie le montant demandé (pas le montant facturé avec commission)
        notify_url: `${process.env.BACKEND_URL}/webhook-transfert`,
        description: `Unités ${operateur} - ${telephone}`,
        lang: 'fr',
      }
    );

    console.log('Réponse API transfert:', JSON.stringify(transfert.data, null, 2));

    // --- ÉTAPE 5 : Enregistrement du résultat dans Firebase ---
    // Bénéfice estimé = commission perçue - frais CinetPay (environ 4% du montant facturé)
    const fraisCinetpay = Math.round(transaction.montantFacture * 0.04);
    const beneficeEstime = transaction.commission - fraisCinetpay;

    // CinetPay transfert retourne code "0" si le transfert est accepté
    const transfertReussi =
      transfert.data.code === '0' ||
      transfert.data.code === 'OK' ||
      transfert.data.code === 0;

    if (transfertReussi) {
      await transactionRef.update({
        statut: 'complete',
        dateComplete: admin.firestore.FieldValue.serverTimestamp(),
        transfertId: transfert.data.data?.transfer_id || null,
        beneficeEstime: Math.round(beneficeEstime),
        fraisCinetpay,
      });
      console.log(`✅ SUCCÈS : ${montantDemande} FCFA d'unités ${operateur} envoyés à ${telephone}`);
    } else {
      await transactionRef.update({
        statut: 'transfert_echoue',
        dateEchec: admin.firestore.FieldValue.serverTimestamp(),
        erreurTransfert: transfert.data.message || 'Erreur inconnue lors du transfert',
      });
      console.error(`❌ ÉCHEC transfert pour ${telephone}:`, transfert.data.message);
    }

  } catch (erreur) {
    console.error('Erreur dans le traitement du webhook:', erreur.message);
  }
});

// ============================================================
// ROUTE 3 : WEBHOOK RETOUR DE TRANSFERT (notification optionnelle)
// POST /webhook-transfert
// CinetPay peut appeler cette route après avoir effectué le transfert
// ============================================================
app.post('/webhook-transfert', async (req, res) => {
  console.log('📩 Webhook transfert reçu:', JSON.stringify(req.body, null, 2));

  try {
    const { transfer_id, status, phone } = req.body;

    if (transfer_id && status) {
      // Cherche la transaction correspondante dans Firebase
      const snapshot = await db
        .collection('transactions')
        .where('transfertId', '==', transfer_id)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        await doc.ref.update({
          statutTransfert: status,
          dateNotifTransfert: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Transfert ${transfer_id} mis à jour : ${status}`);
      }
    }
  } catch (erreur) {
    console.error('Erreur webhook-transfert:', erreur.message);
  }

  res.status(200).json({ message: 'OK' });
});

// ============================================================
// ROUTE 4 : PAGE ADMIN
// GET /admin
// Affiche toutes les transactions du jour avec le bilan financier
// ⚠️ À protéger par un mot de passe en production !
// ============================================================
app.get('/admin', async (req, res) => {
  try {
    // Calcule le début et la fin de la journée actuelle
    const debutJour = new Date();
    debutJour.setHours(0, 0, 0, 0);

    const finJour = new Date();
    finJour.setHours(23, 59, 59, 999);

    // Récupère toutes les transactions du jour, triées de la plus récente à la plus ancienne
    const snapshot = await db
      .collection('transactions')
      .where('dateCreation', '>=', debutJour)
      .where('dateCreation', '<=', finJour)
      .orderBy('dateCreation', 'desc')
      .get();

    // Calcule les totaux
    let totalTransactionsReussies = 0;
    let totalUnitesEnvoyees = 0;
    let totalBenefice = 0;

    const transactions = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      transactions.push(data);

      if (data.statut === 'complete') {
        totalTransactionsReussies++;
        totalUnitesEnvoyees += data.montantDemande || 0;
        totalBenefice += data.beneficeEstime || 0;
      }
    });

    // Formate une date Firestore Timestamp en chaîne lisible
    const formaterDate = (timestamp) => {
      if (!timestamp?.toDate) return '-';
      return timestamp.toDate().toLocaleString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
      });
    };

    // Couleur selon le statut de la transaction
    const couleurStatut = (statut) => {
      const couleurs = {
        complete: '#28a745',
        en_attente: '#ffc107',
        paiement_recu: '#17a2b8',
        transfert_echoue: '#dc3545',
        erreur_creation: '#dc3545',
      };
      return couleurs[statut] || '#6c757d';
    };

    // Génération de la page HTML admin
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Gova Crédit</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; padding: 20px; }
    .entete { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 10px; }
    h1 { color: #333; font-size: 22px; }
    .date-auj { color: #777; font-size: 14px; margin-top: 5px; }
    .btn-actu { background: #FF6B00; color: white; border: none; padding: 10px 18px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 15px; margin-bottom: 25px; }
    .stat { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .stat h3 { color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 10px; }
    .stat .val { font-size: 26px; font-weight: 700; color: #333; }
    .stat.vert .val { color: #28a745; }
    .stat.bleu .val { color: #007bff; }
    .tableau-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); font-size: 13px; }
    thead th { background: #FF6B00; color: white; padding: 12px 15px; text-align: left; font-weight: 600; }
    tbody td { padding: 12px 15px; border-bottom: 1px solid #f0f0f0; color: #444; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: #fafafa; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; color: white; }
    .vide { text-align: center; padding: 40px !important; color: #aaa; font-size: 15px; }
  </style>
</head>
<body>
  <div class="entete">
    <div>
      <h1>📊 Administration — Gova Crédit</h1>
      <p class="date-auj">Transactions du ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
    </div>
    <button class="btn-actu" onclick="location.reload()">🔄 Actualiser</button>
  </div>

  <div class="stats">
    <div class="stat">
      <h3>Total transactions</h3>
      <div class="val">${snapshot.size}</div>
    </div>
    <div class="stat bleu">
      <h3>Réussies</h3>
      <div class="val">${totalTransactionsReussies}</div>
    </div>
    <div class="stat">
      <h3>Unités envoyées</h3>
      <div class="val">${totalUnitesEnvoyees.toLocaleString('fr-FR')} F</div>
    </div>
    <div class="stat vert">
      <h3>Bénéfice net estimé</h3>
      <div class="val">${Math.round(totalBenefice).toLocaleString('fr-FR')} F</div>
    </div>
  </div>

  <div class="tableau-wrap">
    <table>
      <thead>
        <tr>
          <th>Heure</th>
          <th>Téléphone</th>
          <th>Opérateur</th>
          <th>Unités envoyées</th>
          <th>Facturé au client</th>
          <th>Bénéfice net</th>
          <th>Statut</th>
        </tr>
      </thead>
      <tbody>
        ${
          transactions.length === 0
            ? `<tr><td colspan="7" class="vide">Aucune transaction aujourd'hui</td></tr>`
            : transactions
                .map(
                  (t) => `
          <tr>
            <td>${formaterDate(t.dateCreation)}</td>
            <td><strong>${t.telephone || '-'}</strong></td>
            <td>${t.operateur || '-'}</td>
            <td>${(t.montantDemande || 0).toLocaleString('fr-FR')} FCFA</td>
            <td>${(t.montantFacture || 0).toLocaleString('fr-FR')} FCFA</td>
            <td>${t.beneficeEstime != null ? Math.round(t.beneficeEstime).toLocaleString('fr-FR') + ' FCFA' : '-'}</td>
            <td><span class="badge" style="background:${couleurStatut(t.statut)}">${t.statut || '-'}</span></td>
          </tr>`
                )
                .join('')
        }
      </tbody>
    </table>
  </div>
</body>
</html>`);
  } catch (erreur) {
    console.error('Erreur /admin:', erreur.message);
    res.status(500).send('Erreur serveur lors du chargement de la page admin.');
  }
});

// ============================================================
// DÉMARRAGE DU SERVEUR
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 Application  : http://localhost:${PORT}`);
  console.log(`📊 Admin        : http://localhost:${PORT}/admin`);
  console.log(`🔗 Webhook      : ${process.env.BACKEND_URL}/webhook-cinetpay\n`);
});
