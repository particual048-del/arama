const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { execSync } = require('child_process');

// Dosya Yolları
const DATA_FILE = path.join(__dirname, 'colyak_listesi.json');
const URLS_FILE = path.join(__dirname, 'tum_linkler.json');

// Engellenmeyi önlemek için rastgele User-Agent başlıkları
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 1.0 - 1.5 saniye rastgele insan taklidi bekleme süresi
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min = 1000, max = 1500) => Math.floor(Math.random() * (max - min + 1)) + min;

// GitHub'a Commit & Push yapan fonksiyon (Render & GitHub Actions uyumlu)
function commitAndPush(count) {
  try {
    console.log(`\n>>> [OTOMATİK PUSH] ${count} ürün kaydedildi, GitHub'a push yapılıyor...`);
    execSync('git config --global user.name "github-actions[bot]"');
    execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    execSync('git add colyak_listesi.json');
    execSync(`git commit -m "chore: ${count} urun kaydedildi [auto push]"`);

    const token = process.env.GH_TOKEN;
    const repo = process.env.RENDER_GIT_REPO_SLUG; // Örn: kullanıcıadı/depoadı

    if (token && repo) {
      execSync(`git push https://${token}@github.com/${repo}.git HEAD:main`);
    } else {
      execSync('git push');
    }

    console.log('>>> [OTOMATİK PUSH] İşlem başarılı.\n');
  } catch (error) {
    console.log('>>> [PUSH UYARISI] Commit edilecek yeni değişiklik yok veya push atlandı:', error.message);
  }
}

// HTML içeriğinde Cloudflare / Captcha engeli taraması
function isBlockedContent(html) {
  if (!html) return false;
  const lowerHtml = html.toLowerCase();
  const blockKeywords = [
    'cf-browser-verification',
    'g-recaptcha',
    'access denied',
    '403 forbidden',
    'too many requests',
    'just a moment...',
    'enable javascript and cookies'
  ];
  return blockKeywords.some(keyword => lowerHtml.includes(keyword));
}

let consecutiveBlockCount = 0;
const MAX_CONSECUTIVE_BLOCKS = 3;

// İstek Atma ve Engel Kontrol Fonksiyonu
async function fetchWithBlockCheck(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000
    });

    if (isBlockedContent(response.data)) {
      consecutiveBlockCount++;
      console.warn(`\n⚠️ [ENGEL TESPİT EDİLDİ] Captcha veya Bloklama algılandı! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS})`);
      return { data: null, isBlocked: true };
    }

    consecutiveBlockCount = 0; // Başarılı istekte sayacı sıfırla
    return { data: response.data, isBlocked: false };

  } catch (err) {
    const status = err.response ? err.response.status : null;

    if (status === 429 || status === 403) {
      consecutiveBlockCount++;
      console.warn(`\n⚠️ [ENGEL TESPİT EDİLDİ] HTTP ${status} hatası! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS})`);
      return { data: null, isBlocked: true };
    }

    console.error(`[HATA] Bağlantı hatası (${url}): ${err.message}`);
    return { data: null, isBlocked: false };
  }
}

async function scrape() {
  let savedData = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) {
      savedData = [];
    }
  }

  if (!fs.existsSync(URLS_FILE)) {
    console.error(`[KRİTİK HATA] ${URLS_FILE} bulunamadı! Lütfen dosya adını kontrol edin.`);
    process.exit(1);
  }

  const allUrls = JSON.parse(fs.readFileSync(URLS_FILE, 'utf-8'));
  const processedUrls = new Set(savedData.map(item => item.url));
  const remainingUrls = allUrls.filter(url => !processedUrls.has(url));

  console.log(`Toplam Link: ${allUrls.length}`);
  console.log(`Zaten Çekilen: ${processedUrls.size}`);
  console.log(`Kalan İşlenecek: ${remainingUrls.length}\n`);

  let newlyAddedCount = 0;

  for (let i = 0; i < remainingUrls.length; i++) {
    const url = remainingUrls[i];
    const currentIndex = processedUrls.size + newlyAddedCount + 1;

    // Üst üste 3 engel alınırsa botu veri kaybı olmadan durdur
    if (consecutiveBlockCount >= MAX_CONSECUTIVE_BLOCKS) {
      console.error(`\n🚨 [KRİTİK UYARI] Üst üste ${MAX_CONSECUTIVE_BLOCKS} kez engellendi. IP güvenliği için bot durduruluyor.`);
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
      process.exit(1);
    }

    const { data: html, isBlocked } = await fetchWithBlockCheck(url);

    if (isBlocked) {
      await sleep(10000); // Engel yendiğinde 10 saniye bekle
      continue;
    }

    if (!html) continue;

    const $ = cheerio.load(html);
    const title = $('h1').text().trim() || 'Bilinmeyen Ürün';
    const pageText = $('body').text();
    const isGlutenFree = pageText.includes('Glutensiz') || pageText.includes('gluten içermez');

    savedData.push({
      url,
      title,
      glutenFree: isGlutenFree,
      scrapedAt: new Date().toISOString()
    });

    newlyAddedCount++;
    console.log(`[${currentIndex}/${allUrls.length}] Çekildi: ${title}`);

    // Her 20 üründe bir yerele kaydet
    if (newlyAddedCount % 20 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
    }

    // Her 200 üründe bir GitHub'a commit & push at
    if (newlyAddedCount % 200 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
    }

    await sleep(getRandomDelay(1000, 1500));
  }

  // İşlem tamamen bittiğinde son hali push'la
  fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
  commitAndPush(savedData.length);
  console.log('Tüm kazıma işlemi başarıyla tamamlandı!');
}

scrape();
