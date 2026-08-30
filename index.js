const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { execSync } = require('child_process');

const DATA_FILE = path.join(__dirname, 'colyak_listesi.json');
const URLS_FILE = path.join(__dirname, 'tum_linkler.json');

// Her çalıştırmada taranacak MAKSİMUM ürün sayısı (GitHub limitine takılmamak için)
const BATCH_LIMIT = 1000; 

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min = 1000, max = 1500) => Math.floor(Math.random() * (max - min + 1)) + min;

function commitAndPush(count) {
  try {
    console.log(`\n>>> [OTOMATİK PUSH] ${count} ürün JSON veritabanına işlendi, GitHub'a push atılıyor...`);
    execSync('git config --global user.name "github-actions[bot]"');
    execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    
    execSync('git add colyak_listesi.json');
    execSync('git stash');
    execSync('git pull origin main --rebase');
    execSync('git stash pop || true');

    execSync('git add colyak_listesi.json');
    execSync(`git commit -m "chore: ${count} urun veritabanina eklendi [auto push]"`);

    const token = process.env.GH_TOKEN;
    const repo = process.env.RENDER_GIT_REPO_SLUG || process.env.GITHUB_REPOSITORY;

    if (token && repo) {
      execSync(`git push https://${token}@github.com/${repo}.git HEAD:main`);
    } else {
      execSync('git push');
    }

    console.log('>>> [OTOMATİK PUSH] İşlem başarılı. colyak_listesi.json güncellendi.\n');
  } catch (error) {
    console.log(`>>> [PUSH UYARISI] Push atlanıyor/güncel: ${error.message}`);
  }
}

function isBlockedContent(html) {
  if (!html) return false;
  const lowerHtml = html.toLowerCase();
  const blockKeywords = [
    'cf-browser-verification', 'g-recaptcha', 'access denied',
    '403 forbidden', 'too many requests', 'just a moment...', 'enable javascript and cookies'
  ];
  return blockKeywords.some(keyword => lowerHtml.includes(keyword));
}

let consecutiveBlockCount = 0;
const MAX_CONSECUTIVE_BLOCKS = 3;

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
      console.warn(`\n⚠️ [ERİŞİM ENGELİ LOGU] Captcha/Bloklama algılandı! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS}) -> Link: ${url}`);
      return { data: null, isBlocked: true };
    }

    consecutiveBlockCount = 0;
    return { data: response.data, isBlocked: false };

  } catch (err) {
    const status = err.response ? err.response.status : null;

    if (status === 429 || status === 403) {
      consecutiveBlockCount++;
      console.warn(`\n⚠️ [ERİŞİM ENGELİ LOGU] HTTP Status ${status} hatası! (${consecutiveBlockCount}/${MAX_CONSECUTIVE_BLOCKS}) -> Link: ${url}`);
      return { data: null, isBlocked: true };
    }

    console.error(`\n❌ [BAĞLANTI HATASI LOGU] (${url}): ${err.message}`);
    return { data: null, isBlocked: false };
  }
}

function extractBarcode(text, url) {
  const barcodeRegex = /\b869\d{10}\b|\b\d{13}\b/;
  const matchInUrl = url.match(barcodeRegex);
  if (matchInUrl) return matchInUrl[0];

  const matchInText = text.match(barcodeRegex);
  if (matchInText) return matchInText[0];

  return null;
}

async function scrape() {
  let savedData = [];

  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
      savedData = JSON.parse(fileContent);
    } catch (e) {
      savedData = [];
    }
  }

  if (!fs.existsSync(URLS_FILE)) {
    console.error(`[KRİTİK HATA] ${URLS_FILE} dosyası bulunamadı!`);
    process.exit(1);
  }

  const allUrls = JSON.parse(fs.readFileSync(URLS_FILE, 'utf-8'));
  const processedUrls = new Set(savedData.map(item => item.url));
  const remainingUrls = allUrls.filter(url => !processedUrls.has(url));

  console.log(`===========================================`);
  console.log(`Toplam Link Sayısı   : ${allUrls.length}`);
  console.log(`Veritabanındaki Ürün : ${processedUrls.size}`);
  console.log(`Kalan İşlenecek Link : ${remainingUrls.length}`);
  console.log(`Bu Turda İşlenecek  : Math.min(${remainingUrls.length}, ${BATCH_LIMIT})`);
  console.log(`===========================================\n`);

  if (remainingUrls.length === 0) {
    console.log('Tüm ürünler taranmış! İşlem bitti.');
    return;
  }

  let newlyAddedCount = 0;
  // BATCH_LIMIT kadar urun isleyince bu turu sonlandir
  const limit = Math.min(remainingUrls.length, BATCH_LIMIT);

  for (let i = 0; i < limit; i++) {
    const url = remainingUrls[i];
    const currentIndex = processedUrls.size + newlyAddedCount + 1;

    if (consecutiveBlockCount >= MAX_CONSECUTIVE_BLOCKS) {
      console.error(`\n🚨 [KRİTİK ENGEL DURUMU] Üst üste ${MAX_CONSECUTIVE_BLOCKS} kez erişim engeli alındı. İşlem güvenli şekilde durduruluyor.`);
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
      process.exit(1);
    }

    const { data: html, isBlocked } = await fetchWithBlockCheck(url);

    if (isBlocked) {
      await sleep(10000);
      continue;
    }

    if (!html) continue;

    const $ = cheerio.load(html);
    const title = $('h1').text().trim() || 'Bilinmeyen Ürün';
    const rawBodyText = $('body').text();
    
    const pageText = rawBodyText.toLocaleLowerCase('tr-TR');
    const pageTitle = title.toLocaleLowerCase('tr-TR');

    const isGlutenFree = pageText.includes('glutensiz') || 
                         pageTitle.includes('glutensiz') ||
                         pageText.includes('gluten içermez') || 
                         pageText.includes('gluten icermez') ||
                         pageText.includes('gluten-free');

    const barcode = extractBarcode(rawBodyText, url);

    const productData = {
      barcode: barcode,
      title: title,
      glutenFree: isGlutenFree,
      url: url,
      scrapedAt: new Date().toISOString()
    };

    savedData.push(productData);
    newlyAddedCount++;

    console.log(`[${currentIndex}/${allUrls.length}] Çekildi | Ürün: "${title}" | Barkod: ${barcode || 'Bulunamadı'} | Glutensiz: ${isGlutenFree}`);

    if (newlyAddedCount % 20 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
    }

    if (newlyAddedCount % 200 === 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
      commitAndPush(savedData.length);
    }

    await sleep(getRandomDelay(1000, 1500));
  }

  // Tur tamamlandı, son verileri yaz ve pushla
  fs.writeFileSync(DATA_FILE, JSON.stringify(savedData, null, 2));
  commitAndPush(savedData.length);
  console.log(`\nTur başarıyla tamamlandı. ${newlyAddedCount} ürün eklendi.`);
}

scrape();
