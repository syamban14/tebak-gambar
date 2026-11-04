/**
 * Bank Kata Bahasa Indonesia untuk Game Tebak Gambar
 * Dikelompokkan berdasarkan tingkat kesulitan (Mudah, Sedang, Sulit)
 */

const WORD_BANK = {
  easy: [
    'MATAHARI', 'KUCING', 'RUMAH', 'POHON KELAPA', 'BOLA SEPAK',
    'PAYUNG', 'ES KRIM', 'SEPEDA', 'IKAN HIU', 'BURUNG HANTU',
    'PISANG', 'GUNUNG BERAPI', 'KUPU KUPU', 'KACAMATA', 'BINTANG LAUT',
    'MOBIL BALAP', 'JAM DINDING', 'GITAR', 'BALON UDARA', 'SEPATU RODA',
    'KELINCI', 'SEMANGKA', 'LILIN', 'KUNCI PINTU', 'PESAWAT TERBANG',
    'BANTAL', 'TOPI PANTAI', 'BONEKA SALJU', 'PEDANG', 'TELUR MATA SAPI',
    'PELANGI', 'GAJAH', 'KAPAL LAUT', 'EMBER', 'TANGGA',
    'KURSI GOYANG', 'BOTOL MINUM', 'API UNGGUN', 'AWAN HUJAN', 'DONAT',
    'NANAS', 'ULAR KOBRA', 'CINCIN', 'PENSIL', 'GUNTING'
  ],
  medium: [
    'KUCING TIDUR', 'ASTRONOT', 'PEMADAM KEBAKARAN', 'KERETA API', 'LAYANG LAYANG',
    'LAMPU LALU LINTAS', 'ROBOT', 'BAJAK LAUT', 'DINOSAURUS', 'KINCIR ANGIN',
    'KAMERA FOTO', 'HELM MOTOR', 'PANCINGAN IKAN', 'TENDA KEMAH', 'KOMPOR GAS',
    'MESIN CUCI', 'KIPAS ANGIN', 'TEROPONG BINTANG', 'KAPAL SELAM', 'HELIKOPTER',
    'KANGURU', 'GURITA', 'KURA KURA', 'BURUNG MERAK', 'PANDA MAKAN BAMBU',
    'ORANG SAWAH', 'JEMBATAN GANTUNG', 'AIR TERJUN', 'PULAU HARTA KARUN', 'KASTIL KERAJAAN',
    'MIKROFON', 'KOPER TRAVEL', 'SETIR MOBIL', 'KERANJANG BELANJA', 'SIKAT GIGI',
    'BAKSO MANGKUK', 'SATE AYAM', 'NASI TUMPENG', 'MIE INSTAN', 'KOPI PANAS',
    'DOKTER GIGI', 'PENJAGA GAWANG', 'PESULAP', 'NINJA', 'PUTRI DUYUNG'
  ],
  hard: [
    'MENARA EIFFEL', 'CANDI BOROBUDUR', 'MONAS JAKARTA', 'PATUNG LIBERTY', 'TEMBOK BESAR CINA',
    'GERHANA MATAHARI', 'LOMPAT INDAH', 'PANJAT TEBING', 'SELANCAR OMBAK', 'TERJUN PAYUNG',
    'DEMAM PANGGUNG', 'MATI LAMPU', 'JALAN MACET', 'KEHABISAN BENSIN', 'HUJAN DERAS',
    'KEjar TAYANG', 'TIDUR SIANG', 'MIMPI BURUK', 'POTONG RAMBUT', 'CUCI PIRING',
    'TARIK TAMBANG', 'BALAP KARUNG', 'PANJAT PINANG', 'MAIN PETAK UMPET', 'LOMPAT TALI',
    'MESIN WAKTU', 'PIRING TERBANG', 'KARPET AJAIB', 'LAMPU ALADDIN', 'POHON UANG',
    'KACA PEMBESAR', 'JAM PASIR', 'KOMPAS ARAH', 'STETOSKOP', 'MIKROSKOP',
    'PANGGANG ROTI', 'PENYEDOT DEBU', 'SETRIKA BAJU', 'PENGERING RAMBUT', 'TIMBANGAN BADAN'
  ]
};

/**
 * Mengambil 3 pilihan kata acak (1 mudah, 1 sedang, 1 sulit)
 * yang belum pernah dipakai di sesi room tersebut.
 */
function getThreeWordChoices(usedWordsSet = new Set()) {
  const pickRandom = (list, diffLabel) => {
    const available = list.filter(w => !usedWordsSet.has(w));
    const pool = available.length > 0 ? available : list;
    const word = pool[Math.floor(Math.random() * pool.length)];
    return {
      word,
      difficulty: diffLabel,
      letterCount: word.replace(/\s+/g, '').length
    };
  };

  return [
    pickRandom(WORD_BANK.easy, 'Mudah'),
    pickRandom(WORD_BANK.medium, 'Sedang'),
    pickRandom(WORD_BANK.hard, 'Sulit')
  ];
}

module.exports = {
  WORD_BANK,
  getThreeWordChoices
};
