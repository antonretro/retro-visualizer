// Battery remake - the 14 SHIFT (warp) classes.
// Spec: re/battery/SHIFTS_SPEC.md (bit-exact vs wmp.dll), reference model re/battery/shifts_model.py,
// randomisers from the decompiled slot-3 functions (tools/wmp_b/range.c FUN_18052ae70..FUN_18052b800).
// map(x, y, E) returns the raw [sx, sy] of the real slot-8 function; the engine applies the
// out-of-range rule (this.outOfRangeKeep) and builds the table.
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./engine.js');
(function (B) {
  'use strict';
  var fr = Math.fround;
  var F_1EM4 = fr(1e-4);            // 9.999999747e-05 (float 1e-4 widened)
  var F_PI = fr(Math.PI);           // 3.141592741
  var F_32767 = fr(32767);
  var F_0_1 = fr(0.1), F_0_05 = fr(0.05), F_0_2 = fr(0.2), F_0_4 = fr(0.4), F_0_6 = fr(0.6), F_0_8 = fr(0.8);

  // ---- ucrt (x64) sin / cos / atan2, bit-exact ports --------------------------------------------
  // The real maps call ucrtbase sin/cos/atan2; V8's Math.* differ by 1 ulp in a few % of cases, which
  // flips trunc() on knife-edge pixels (axes, diagonals, identity-like params). These are ports of
  // ucrtbase.dll's code: sin/cos = its FMA3 path (taken on any CPU with FMA3), atan2 = its C path.
  var f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  function hx(hi, lo) { u32[1] = hi; u32[0] = lo; return f64[0]; }
  // Allocation-free form: every helper leaves its double result in the FR "registers" (a Float64Array) instead
  // of returning it, because a double returned from a call that the JIT does not inline is boxed (a heap
  // allocation per call: several hundred KB per frame while a shift table is being built).
  // FR[0] sin/cos/atan2 result, FR[1] fma, FR[2] addRO, FR[3]/FR[4] remPio2 head/tail, FR[5] sin/cos poly.
  var FR = new Float64Array(8), FA = new Float64Array(4), FX = new Float64Array(2);
  // inputs too go through registers (double arguments of a call that is not inlined are boxed as well):
  // fma: FA[0..2], addRO: FA[3] + local, sin/cos: FX[0], atan2: FX[0] (y), FX[1] (x), remPio2: FR[6]
  // round-to-odd sum (Boldo-Melquiond), used for an exact fma emulation -> FR[2]
  function addRO(y) {
    var x = FA[3];
    var s = x + y, bb = s - x, err = (x - (s - bb)) + (y - bb);
    if (err === 0) { FR[2] = s; return; }
    f64[0] = s;
    if (u32[0] & 1) { FR[2] = s; return; }
    var up = (err > 0) === (s > 0);   // move away from zero?
    if (up) { if (u32[0] === 0xffffffff) { u32[0] = 0; u32[1]++; } else u32[0]++; }
    else { if (u32[0] === 0) { u32[0] = 0xffffffff; u32[1]--; } else u32[0]--; }
    FR[2] = f64[0];
  }
  var SPLIT = 134217729;
  function fma() {                  // correctly rounded a*b+c (finite, no under/overflow in our range) -> FR[1]
    var a = FA[0], b = FA[1], c = FA[2];
    var p = a * b, t = SPLIT * a, ah = t - (t - a), al = a - ah;
    t = SPLIT * b; var bh = t - (t - b), bl = b - bh;
    var e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    var s = c + p, bb = s - c, tl = (c - (s - bb)) + (p - bb);
    FA[3] = tl; addRO(e);
    FR[1] = s + FR[2];
  }
  var PIO4 = hx(0x3fe921fb, 0x54442d18), TWO_M13 = hx(0x3f200000, 0), TWO_M27 = hx(0x3e400000, 0),
    BIGARG = 2e7, MAGIC = hx(0x43380000, 0), TWOBYPI = hx(0x3fe45f30, 0x6dc9c883),
    PIO2_1 = hx(0x3ff921fb, 0x54442d18), PIO2_1T = hx(0x3c91a626, 0x33145c00), PIO2_2T = hx(0x397b839a, 0x252049c0),
    SIXTH = hx(0x3fc55555, 0x55555555),
    S6 = hx(0x3de5e0b2, 0xf9a43bb8), S5 = hx(0xbe5ae600, 0xb42fdfa7), S4 = hx(0x3ec71de3, 0x796cde01),
    S3 = hx(0xbf2a01a0, 0x19e83e5c), S2 = hx(0x3f811111, 0x11110bb3), S1 = hx(0xbfc55555, 0x55555555),
    C6 = hx(0xbda907db, 0x47258aa7), C5 = hx(0x3e21eeb6, 0x90382eec), C4 = hx(0xbe927e4f, 0xa17f667b),
    C3 = hx(0x3efa01a0, 0x19f4ec91), C2 = hx(0xbf56c16c, 0x16c16967), C1 = hx(0x3fa55555, 0x55555555);
  var RQ = 0;
  function remPio2() {              // x = FR[6] >= pi/4, < 2e7 -> RQ, FR[3] (head), FR[4] (tail)
    var x = FR[6];
    FA[0] = x; FA[1] = TWOBYPI; FA[2] = MAGIC; fma(); var n = FR[1] - MAGIC;
    RQ = n & 3;
    FA[0] = -n; FA[1] = PIO2_1; FA[2] = x; fma(); var r1 = FR[1], x3 = n * PIO2_1T;
    FA[0] = n; FA[1] = PIO2_1T; FA[2] = -x3; fma(); var x0 = FR[1];
    var x5 = r1 - x3, x4 = (r1 - x5) - x3;
    FA[0] = -n; FA[1] = PIO2_1T; FA[2] = r1; fma(); var rh = FR[1];
    x5 = ((x5 - rh) + x4) - x0;
    FA[0] = -n; FA[1] = PIO2_2T; FA[2] = x5; fma();
    FR[3] = rh; FR[4] = FR[1];
  }
  function sinPoly() {              // rh = FR[3], rt = FR[4] -> FR[5]
    var rh = FR[3], rt = FR[4], x2 = rh * rh;
    FA[0] = S6; FA[1] = x2; FA[2] = S5; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S4; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S3; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S2; fma();
    var p = FR[1];
    var x3 = rh * x2, t = x3 * p;
    t = (rt * 0.5) - t; t = x2 * t; t = t - rt;
    FA[0] = -x3; FA[1] = S1; FA[2] = t; fma();
    FR[5] = rh - FR[1];
  }
  function cosPoly() {              // rh = FR[3], rt = FR[4] -> FR[5]
    var rh = FR[3], rt = FR[4], x2 = rh * rh;
    var h = x2 * 0.5, w = 1.0 - h, t = (1.0 - w) - h;
    FA[0] = -rh; FA[1] = rt; FA[2] = t; fma(); t = FR[1];
    var x4 = x2 * x2;
    FA[0] = C6; FA[1] = x2; FA[2] = C5; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C4; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C3; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C2; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C1; fma();
    FA[0] = FR[1]; FA[1] = x4; FA[2] = t; fma();
    FR[5] = FR[1] + w;
  }
  function usin() {                 // x = FX[0] -> FR[0]
    var x = FX[0];
    var ax = Math.abs(x), r;
    if (ax < PIO4) {
      if (ax < TWO_M13) { if (ax < TWO_M27) { FR[0] = x; return; } FA[0] = -(x * x * x); FA[1] = SIXTH; FA[2] = x; fma(); FR[0] = FR[1]; return; }
      var x2 = x * x;
      FA[0] = S6; FA[1] = x2; FA[2] = S5; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S4; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S3; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = S2; fma();
      var x3 = x * x2; FA[0] = FR[1]; FA[1] = x2; FA[2] = S1; fma();
      FA[0] = x3; FA[1] = FR[1]; FA[2] = x; fma(); FR[0] = FR[1]; return;
    }
    if (!(ax < BIGARG)) { FR[0] = Math.sin(x); return; }
    FR[6] = ax; remPio2();
    if (RQ & 1) cosPoly(); else sinPoly();
    r = FR[5];
    FR[0] = (((RQ & 2) !== 0) !== (x < 0)) ? -r : r;
  }
  function ucos() {                 // x = FX[0] -> FR[0]
    var x = FX[0];
    var ax = Math.abs(x), r;
    if (!(ax > PIO4)) {
      if (ax < TWO_M13) { if (ax < TWO_M27) { FR[0] = 1.0; return; } FA[0] = -x; FA[1] = x * 0.5; FA[2] = 1.0; fma(); FR[0] = FR[1]; return; }
      var x2 = x * x;
      FA[0] = C6; FA[1] = x2; FA[2] = C5; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C4; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C3; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C2; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = C1; fma();
      FA[0] = FR[1]; FA[1] = x2; FA[2] = -0.5; fma(); FA[0] = FR[1]; FA[1] = x2; FA[2] = 1.0; fma(); FR[0] = FR[1]; return;
    }
    if (!(ax < BIGARG)) { FR[0] = Math.cos(x); return; }
    FR[6] = ax; remPio2();
    if (RQ & 1) sinPoly(); else cosPoly();
    r = FR[5];
    FR[0] = ((RQ + 1) & 2) ? -r : r;
  }
  // atan_jby256_lead / _tail from AMD LibM (aocl-libm-ose), Copyright (C) 2008-2026 Advanced Micro Devices, Inc.,
  // BSD 3-Clause License: see THIRD_PARTY_AMD_LIBM.txt in the project root.
  var ATAN_LEAD = [
    0.06241878867149353,0.06630885601043701,0.07019692659378052,0.07408291101455688,0.07796663045883179,
    0.08184796571731567,0.08572685718536377,0.08960312604904175,0.09347677230834961,0.09734755754470825,
    0.1012154221534729,0.105080246925354,0.10894191265106201,0.11280035972595215,0.11665540933609009,
    0.12050700187683105,0.12435495853424072,0.12819921970367432,0.13203966617584229,0.13587629795074463,
    0.1397087574005127,0.14353728294372559,0.1473613977432251,0.15118122100830078,0.15499663352966309,
    0.15880751609802246,0.16261374950408936,0.16641521453857422,0.17021191120147705,0.1740034818649292,
    0.17779016494750977,0.1815716028213501,0.18534791469573975,0.18911874294281006,0.19288420677185059,
    0.19664418697357178,0.20039844512939453,0.2041471004486084,0.20788991451263428,0.21162676811218262,
    0.21535766124725342,0.21908247470855713,0.2228010892868042,0.22651350498199463,0.23021948337554932,
    0.2339191436767578,0.23761224746704102,0.24129879474639893,0.24497854709625244,0.2486516237258911,
    0.2523179054260254,0.25597715377807617,0.259629487991333,0.2632746696472168,0.26691293716430664,
    0.27054381370544434,0.2741672992706299,0.2777836322784424,0.28139233589172363,0.28499364852905273,
    0.2885873317718506,0.2921731472015381,0.29575157165527344,0.29932212829589844,0.3028848171234131,
    0.3064393997192383,0.3099863529205322,0.3135249614715576,0.31705570220947266,0.32057809829711914,
    0.32409238815307617,0.32759833335876465,0.33109593391418457,0.33458518981933594,0.33806610107421875,
    0.3415381908416748,0.3450021743774414,0.34845709800720215,0.35190367698669434,0.35534143447875977,
    0.35877060890197754,0.36219072341918945,0.3656022548675537,0.3690047264099121,0.37239837646484375,
    0.37578296661376953,0.37915849685668945,0.3825252056121826,0.3858826160430908,0.38923096656799316,
    0.39257001876831055,0.39590001106262207,0.39922070503234863,0.40253210067749023,0.4058341979980469,
    0.40912699699401855,0.41241025924682617,0.41568422317504883,0.4189488887786865,0.42220401763916016,
    0.4254496097564697,0.42868566513061523,0.4319121837615967,0.43512916564941406,0.4383363723754883,
    0.44153428077697754,0.44472241401672363,0.44790077209472656,0.45106959342956543,0.45422863960266113,
    0.45737791061401367,0.46051764488220215,0.46364760398864746,0.4667675495147705,0.4698779582977295,
    0.4729785919189453,0.47606921195983887,0.47915005683898926,0.4822211265563965,0.48528242111206055,
    0.48833394050598145,0.4913754463195801,0.49440693855285645,0.49742889404296875,0.5004405975341797,
    0.5034427642822266,0.5064349174499512,0.5094170570373535,0.5123891830444336,0.5153517723083496,0.5183043479919434,
    0.5212469100952148,0.5241794586181641,0.527101993560791,0.5300149917602539,0.5329179763793945,0.5358109474182129,
    0.538693904876709,0.541567325592041,0.5444307327270508,0.5472841262817383,0.5501275062561035,0.5529613494873047,
    0.5557851791381836,0.5585989952087402,0.5614032745361328,0.5641975402832031,0.5669817924499512,0.569756031036377,
    0.5725207328796387,0.5752758979797363,0.5780210494995117,0.5807561874389648,0.5834817886352539,0.5861973762512207,
    0.5889034271240234,0.5915994644165039,0.5942859649658203,0.5969629287719727,0.5996298789978027,0.6022872924804688,
    0.6049346923828125,0.6075730323791504,0.610201358795166,0.6128201484680176,0.6154289245605469,0.6180286407470703,
    0.6206188201904297,0.6231989860534668,0.625770092010498,0.628331184387207,0.6308832168579102,0.6334257125854492,
    0.6359586715698242,0.6384820938110352,0.640995979309082,0.643500804901123,0.64599609375,0.6484823226928711,
    0.6509590148925781,0.6534261703491211,0.6558842658996582,0.6583328247070312,0.6607723236083984,0.6632027626037598,
    0.665623664855957,0.6680359840393066,0.6704387664794922,0.6728324890136719,0.6752166748046875,0.6775922775268555,
    0.6799588203430176,0.6823163032531738,0.6846647262573242,0.6870040893554688,0.6893348693847656,0.6916565895080566,
    0.6939692497253418,0.6962728500366211,0.6985678672790527,0.7008543014526367,0.7031316757202148,0.7054004669189453,
    0.7076601982116699,0.7099113464355469,0.7121539115905762,0.7143878936767578,0.7166132926940918,0.7188296318054199,
    0.7210378646850586,0.7232375144958496,0.725428581237793,0.7276110649108887,0.7297854423522949,0.7319507598876953,
    0.7341084480285645,0.7362570762634277,0.7383975982666016,0.7405300140380859,0.7426543235778809,0.7447700500488281,
    0.7468776702880859,0.7489767074584961,0.751068115234375,0.7531509399414062,0.7552261352539062,0.7572927474975586,
    0.7593517303466797,0.7614026069641113,0.7634453773498535,0.7654800415039062,0.7675070762634277,0.7695260047912598,
    0.7715373039245605,0.7735409736633301,0.7755365371704102,0.7775239944458008,0.7795042991638184,0.7814764976501465,
    0.7834410667419434,0.785398006439209];
  var ATAN_TAIL = [
    2.132446381820054e-08,3.8909386476171276e-08,4.4478090000943745e-08,1.1534476846011275e-08,3.372710519453953e-09,
    2.4085760873610986e-08,1.858538104506238e-08,5.143582999692251e-08,8.850239854129525e-09,1.5942515421435843e-08,
    1.9513993773775575e-08,2.6490975527354432e-08,4.433880378812311e-08,2.1475707242182127e-08,2.6104979267075422e-08,
    7.814393506744663e-09,3.60125207123751e-08,6.152762381793438e-08,9.543879646411843e-08,3.0278956685150275e-08,
    1.1688865094987086e-07,1.0758095646865334e-08,8.334542653795354e-08,1.1079027927262953e-07,1.0839427789636621e-07,
    9.221760861268411e-08,7.909385921990488e-08,8.664454071642931e-08,1.4083997353709244e-08,1.190704385073076e-07,
    6.404516630517162e-08,1.0833868207634367e-07,3.5299955018792274e-08,1.0598327393004308e-07,1.0548612407825955e-07,
    5.821677322817765e-08,1.0869648398340394e-07,4.4733508612237754e-08,1.2689628716261572e-08,4.065344715891514e-08,
    3.84504846300557e-08,3.607150064048073e-08,6.447259031655227e-08,3.6374924997640946e-08,1.0390129441383391e-07,
    6.253797563021679e-08,6.639843023684888e-08,3.218445989715483e-08,1.1603061171276583e-07,1.1746462214234773e-07,
    7.54604017965809e-08,1.4923492935620656e-07,1.4141692452321743e-07,2.133080656174835e-07,5.042309379333023e-08,
    5.458749222816555e-08,1.5184902891478687e-07,3.090043087037693e-08,9.675745481847383e-08,4.025082855293222e-08,
    3.012222680968611e-08,2.361898606700793e-07,1.1409515811108089e-07,7.423490897465735e-08,5.125155831962304e-08,
    2.1929039182876392e-07,3.832635121875539e-08,1.6151348628409052e-07,5.099967435355899e-08,1.2369403786124677e-07,
    8.233679553511238e-08,1.075917662130537e-07,1.4278994752463182e-07,1.3234712302471188e-07,2.1762606731659815e-08,
    2.344548669230443e-07,2.829663702617669e-09,2.2930091989090763e-07,1.4842827045026128e-07,1.8793740857431398e-07,
    6.13685946813334e-08,1.9858502273358382e-07,7.68394131623753e-08,1.2811905231243675e-07,7.021191047192365e-08,
    9.879547938206363e-08,1.7217675238103499e-07,1.128772251461697e-08,5.3354982955585174e-08,2.1383327571081652e-08,
    1.1624351804829056e-07,6.299264083690559e-08,6.45429039328022e-08,8.640019228142819e-08,9.507675722023258e-08,
    5.8085149750812114e-08,1.8235056113502477e-07,1.989486805873906e-07,7.835486634501977e-08,3.043742344867986e-08,
    2.761357256297974e-08,4.3261010545420307e-08,5.1710751532412726e-08,2.8239832787584144e-08,1.874824695241956e-07,
    2.974818916627141e-08,9.944215708435843e-09,1.0705621073039185e-07,6.255895804668812e-08,9.566410138694646e-08,
    1.8805630714835544e-07,8.388506893795579e-08,5.012158655276741e-09,1.741660959985221e-07,9.967795743953636e-08,
    5.984320263683215e-09,1.1836292236688758e-07,1.8608683328415422e-07,1.9767145725134894e-07,1.4244716071719924e-07,
    1.0550424078554657e-08,3.133352183716392e-08,1.9651841890191454e-07,2.1769203503917354e-08,2.1561311442652998e-07,
    5.682710983004412e-08,1.7033145582336912e-08,9.175900280957096e-08,2.7726630411291657e-07,9.37041937614657e-08,
    1.561163463683168e-08,4.139674338083827e-08,1.7016474918582162e-07,4.017087885456001e-07,2.5966353922605055e-07,
    2.2200748765502747e-07,2.905422508096441e-07,4.677205376666289e-07,2.7979980395677255e-07,2.0734455232743255e-07,
    2.547056986927352e-07,4.2684858953954845e-07,2.525067236335522e-07,2.146841299338497e-07,3.201348222015965e-07,
    9.935375657498557e-08,3.7079294482791725e-08,1.417727493690837e-07,4.224466014901988e-07,4.118184337248015e-07,
    1.199763815026053e-07,3.437030785715209e-08,1.6612870555545327e-07,5.00499610023283e-08,1.7510513994120806e-07,
    7.708071467290303e-08,2.4591860752689584e-07,2.183590209586262e-07,8.443428879764453e-09,1.0750614868788863e-07,
    5.365449543168209e-08,3.391091015183966e-07,2.600987202939206e-08,8.426789916646215e-08,5.3697223747018363e-08,
    4.281925581719217e-07,2.7153549148395514e-07,7.840949981450758e-08,3.4388059913411743e-07,1.3287806506036648e-07,
    4.1804680262796763e-07,2.65042411765766e-07,1.7038369534751864e-07,1.5409649725961352e-07,2.3654340241245981e-07,
    4.3841635010687674e-07,3.038921613399278e-07,3.311367716056649e-07,6.494942945265907e-08,4.1042342988718135e-09,
    1.7083164086911385e-07,1.1081151265790918e-07,3.236777247497836e-07,3.556627342591927e-07,2.3010233348973822e-07,
    4.4742900400073863e-07,7.781671356173296e-08,9.903452919085354e-08,5.858009131431137e-08,4.5785906241087184e-07,
    3.6799306972339093e-07,2.908364643229773e-07,2.516215742501314e-07,2.757898247406528e-07,3.889857762503144e-07,
    1.4021408018376802e-07,3.234514322235505e-08,9.159791807306084e-08,3.4437140249864047e-07,3.404018972150595e-07,
    1.0643181345370795e-07,1.4620423893233885e-07,9.94610376972039e-09,2.0171152809268177e-07,2.7202797798619157e-07,
    2.4840260251169376e-07,1.5848001121924962e-07,3.003728281133687e-08,3.67816204583542e-07,2.461697930323438e-07,
    1.7008046827020425e-07,1.6780671776387291e-07,2.6771562200690794e-07,2.1441134255029917e-08,
    4.1122822128366907e-07,3.5231175239674966e-08,3.527180003973678e-07,4.3885738799291113e-07,3.2257460675348254e-07,
    3.287303711828043e-08,7.566724706076393e-08,3.267501553163697e-09,3.217244453620953e-07,1.0663942737177657e-07,
    3.410207881395247e-07,1.0058283863123255e-07,3.6843943385927664e-07,2.20403078342388e-07,1.6284146709829814e-07,
    2.2532534829668073e-07,4.374622382264216e-07,3.520558805550407e-07,4.756143984947818e-07,3.609983990332153e-07,
    3.7929243461151395e-08,1.298590155285493e-08,3.159275469854749e-07,2.2853367988737967e-08,1.1722254182355313e-07,
    1.5199120840546442e-07,1.5695823932524066e-07];
  var PIO2_LO = hx(0x3c91a626, 0x33145c07), PI_HI = hx(0x400921fb, 0x50000000), PI_LO = hx(0x3e6110b4, 0x611a6263);
  function expo(v) { f64[0] = v; return (u32[1] >>> 20) & 0x7ff; }
  function chop(v, mask) { f64[0] = v; u32[0] &= mask; return f64[0]; }
  // ucrt atan2 for finite y, x where neither is tiny/denormal (the shifts only pass ints)
  function uatan2() {               // y = FX[0], x = FX[1] -> FR[0]
    var y = FX[0], x = FX[1];
    if (y !== y || x !== x || !isFinite(y) || !isFinite(x)) { FR[0] = Math.atan2(y, x); return; }
    var xneg = x < 0 || (x === 0 && 1 / x < 0), yneg = y < 0 || (y === 0 && 1 / y < 0);
    if (y === 0) { FR[0] = xneg ? (yneg ? -Math.PI : Math.PI) : y; return; }
    var ex = expo(x), ey = expo(y);
    if ((ex < 0x3fd && ey < 0x3fd) || (ex === 0 && x !== 0)) { FR[0] = Math.atan2(y, x); return; } // tiny args: not ported
    var diff = ey - ex;
    if (diff > 0x38) { FR[0] = yneg ? -1.5707963267948966 : 1.5707963267948966; return; }
    if (diff < -0x1c && !xneg) {
      if (diff >= -0x3fe) { FR[0] = y / x; return; }
      { FR[0] = Math.atan2(y, x); return; }                                                  // underflow: not ported
    }
    if (diff < -0x38 && xneg) { FR[0] = yneg ? -Math.PI : Math.PI; return; }
    var u = Math.abs(y), v = Math.abs(x), swap = u > v, tmp, lead, tail;
    if (swap) { tmp = u; u = v; v = tmp; }
    var q = u / v;
    if (q > 0.0625) {
      var idx = (q * 256.0 + 0.5) | 0, c = idx * 0.00390625;
      lead = ATAN_LEAD[idx - 16];
      var m = 0x3ff - expo(v), m1 = (m / 2) | 0, m2 = m - m1;
      var sc1 = hx((0x3ff + m1) << 20, 0), sc2 = hx((0x3ff + m2) << 20, 0);
      var vs = (sc1 * v) * sc2, us = (sc1 * u) * sc2;
      var vh = chop(vs, 0xf8000000), vl = vs - vh;
      var num = ((us - vh * c) - vl * c), den = c * us + vs;
      var r = num / den, r2 = r * r;
      tail = (r + ATAN_TAIL[idx - 16]) - ((0.33333333333224097 - r2 * 0.19999918038989142) * r2) * r;
    } else {
      lead = 0.0;
      if (1e-8 > q) tail = q;
      else {
        var q2 = q * q, vh2 = chop(v, 0), vl2 = v - vh2, qh = chop(q, 0);
        var cc = ((u - qh * vh2) - vl2 * qh) - (q - qh) * v;
        cc = cc / v;
        var pp = 0.3333333333333317 - (0.19999999999393223 - (0.1428571356180717 - (0.11110736283514526 - q2 * 0.09002981028544979) * q2) * q2) * q2;
        tail = q + (cc - pp * (q2 * q));
      }
    }
    if (swap) { lead = 1.5707963267948966 - lead; tail = PIO2_LO - tail; }
    if (xneg) { lead = PI_HI - lead; tail = PI_LO - tail; }
    var res = lead + tail;
    { FR[0] = yneg ? -res : res; return; }
  }
  // value-returning wrappers (tests, other callers); the engine itself uses the register forms
  function vsin(x) { FX[0] = x; usin(); return FR[0]; }
  function vcos(x) { FX[0] = x; ucos(); return FR[0]; }
  function vatan2(y, x) { FX[0] = y; FX[1] = x; uatan2(); return FR[0]; }
  function vfma(a, b, c) { FA[0] = a; FA[1] = b; FA[2] = c; fma(); return FR[1]; }
  if (!B.ucrt) B.ucrt = { sin: vsin, cos: vcos, atan2: vatan2, fma: vfma };
  if (!B.ucrtR) B.ucrtR = { sin: usin, cos: ucos, atan2: uatan2, FR: FR, FX: FX };
  // ------------------------------------------------------------------------------------------------

  // cvttsd2si: truncate toward zero; NaN / out of int32 range -> INT_MIN
  // map() results go through one shared pair (read immediately by the engine): no allocation per pixel
  var RET = [0, 0];
  function R2(a, b) { RET[0] = a; RET[1] = b; return RET; }
  function T(v) { return (v > -2147483649 && v < 2147483648) ? (v < 0 ? Math.ceil(v) : Math.floor(v)) | 0 : -2147483648; }
  // U() = (float)rand() / 32767.0f
  function U(E) { return fr(fr(E.rand()) / F_32767); }
  // [-0.05, 0.05]: F(F(U*0.1f) - 0.05f)
  function twist(E) { return fr(fr(U(E) * F_0_1) - F_0_05); }
  // CTrigShift / CTrigStretchShift amount: F(F(U*0.1) - 0.05f), U*0.1 in double
  function trigAmt(E) { return fr(fr(U(E) * 0.1) - F_0_05); }

  // Polar helpers (dx, dy, squared sum in int; atan2/sqrt in double)
  function polarA(x, y, w, h) { return (FX[0] = (h >> 1) - y, FX[1] = (w >> 1) - x, uatan2(), FR[0]); }
  function polarR(x, y, w, h) { var dx = (w >> 1) - x, dy = (h >> 1) - y; return Math.sqrt(dx * dx + dy * dy); }
  function out(ang, r, w, h) {
    var sy = T((FX[0] = ang, usin(), FR[0]) * r), sx = T((FX[0] = ang, ucos(), FR[0]) * r);
    return R2((w - (w >> 1)) - sx, (h - (h >> 1)) - sy);
  }
  function trigf(a, x, mode) {
    if (mode === 0) return (FX[0] = a, ucos(), FR[0]) / 1.57;
    if (mode === 1) return (FX[0] = a, usin(), FR[0]) / 1.57;
    if (mode === 2) return ((x & 1) ? (FX[0] = a, usin(), FR[0]) : (FX[0] = a, ucos(), FR[0])) / 1.57;
    return 0.0;
  }

  class CStretchShift extends B.Shift {
    constructor() { super(); this.outOfRangeKeep = false; }
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = fr(U(E) * 0.3); }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h);
      var k = T(h * d[1]), t = (w >= 2) ? r / (w >> 1) : 0.0;
      return out(a + t * d[0], r - t * t * t * k, w, h);
    }
  }

  class CStarburstShift extends B.Shift {
    randomizeParams(E) {
      this.dbl[0] = twist(E); this.dbl[1] = fr(U(E) * 0.3);
      var m = E.rand() % 40; this.dbl[2] = m % 2 + m;
      this.dbl[3] = E.rand() % 2;
    }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h), r2;
      var k = T(h * d[1]), t = r / (w >> 1);
      if (d[3] === 0.0) {
        t = t * (FX[0] = T(d[2]) * a, usin(), FR[0]); r2 = r + t * t * t * k;
      } else {
        if (d[2] === 0.0) d[2] = 1.0;             // written back (persists)
        r2 = (T(a / (6.28 / d[2])) & 1) ? r + t * t * t * k : r - t * t * t * k;
      }
      return out(a + t * d[0], r2, w, h);
    }
  }

  class CRingSpinShift extends B.Shift {
    constructor() { super(); this.outOfRangeKeep = false; }
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = fr(U(E) * 0.8); }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h);
      var P = (h >> 1) * d[1]; if (P === 0.0) P = F_1EM4;
      var m = r - T(r / P) * P;
      return out(a + d[0], r - (m / P) * m, w, h);
    }
  }

  // NOTE: consumes one E.rand() per pixel (row-major build order) for the frozen jitter.
  class CSwirlShift extends B.Shift {
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = (E.rand() % 20) - 10.0; this.dbl[2] = (E.rand() % 24) - 12.0; }
    map(x0, y0, E) {
      var w = E.W, h = E.H, d = this.dbl, cx = w >> 1, cy = h >> 1;
      var x1 = T((FX[0] = (d[2] + d[2]) * 3.14 / h * y0, usin(), FR[0]) * d[1]) + x0;
      var y1 = y0 + T((FX[0] = (d[2] + d[2]) * 3.14 / w * x0, ucos(), FR[0]) * d[1]);
      var a = polarA(x1, y1, w, h) + d[0], r = polarR(x1, y1, w, h);
      var s = out(a, r - (FX[0] = a * d[2], usin(), FR[0]) * d[1], w, h);
      var j = E.rand() % 4 - 2;
      s[1] += (y0 < cy) ? -j : j;
      s[0] += (x0 < cx) ? -j : j;
      return s;
    }
  }

  function tileF(v, P) { var m = v - T(v / P) * P, q = m / P; return v - T(q * q * q * m); }
  class CTileShift extends B.Shift {
    constructor() { super(); this.mask = 1; }
    randomizeParams(E) { this.dbl[0] = fr(U(E) * 0.2); }
    map(x, y, E) {
      var P = E.H * this.dbl[0]; if (P === 0.0) P = F_1EM4;
      return R2(tileF(x, P), tileF(y, P));
    }
  }

  class CLinearShift extends B.Shift {
    randomizeParams(E) { this.dbl[0] = E.rand() % 6 - 3; this.dbl[1] = E.rand() % 6 - 3; }
    map(x, y, E) { return R2(x + T(this.dbl[0]), y + T(this.dbl[1])); }
  }

  class CTwirlocity extends B.Shift {
    randomizeParams(E) { this.dbl[0] = E.rand() % 50 + 1; this.dbl[1] = fr(U(E) * F_0_6); this.dbl[2] = E.rand() % 10; }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h);
      var R = fr(fr(h) * 0.5), s;
      if (d[2] === 0.0) s = (R !== 0) ? r / R : 0.0; else s = (r !== 0) ? R / r : 0.0;
      return out(a + (FX[0] = s * F_PI * d[0], ucos(), FR[0]) * d[1], r, w, h);
    }
  }

  class CShiitake extends B.Shift {
    randomizeParams(E) {
      var d = this.dbl, v, k, n;
      d[0] = fr(fr(U(E) * 11) - 1);
      v = (E.rand() % 100 === 0) ? fr(U(E) * 16) : fr(U(E) * F_0_05);
      d[1] = fr(v * F_PI);
      d[2] = (E.rand() % 100 === 0) ? fr(U(E) * 8) : fr(U(E) * F_0_05);
      k = E.rand() % 10;
      if (k === 0) n = E.rand() % 100; else if (k > 3) n = E.rand() % 2; else n = E.rand() % 5;
      d[3] = n + 1;
    }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h), cy = h >> 1;
      var r2 = r + d[0], ph = (cy !== 0) ? (r2 + r2) * F_PI / cy : r2;
      return out(a + (FX[0] = ph * d[3], ucos(), FR[0]) * d[1] + ph * d[2], r2, w, h);
    }
  }

  class CThingusShift extends B.Shift {
    randomizeParams(E) { this.dbl[0] = fr(fr(U(E) * F_0_8) - F_0_4); this.dbl[1] = fr(U(E) * F_0_2); }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, a = polarA(x, y, w, h), r = polarR(x, y, w, h);
      var k = ((w >> 2) - r) / ((w >> 1) + (w >> 2));
      return out(a + k * d[0], w * d[1] * k + r, w, h);
    }
  }

  class CTrigShift extends B.Shift {
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = trigAmt(E); this.dbl[2] = E.rand() % 3; }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, D = Math.sqrt(w * w + h * h) * 0.5;
      if (D === 0) D = F_1EM4;
      var a = polarA(x, y, w, h), r = polarR(x, y, w, h), f = trigf(a, x, T(d[2]));
      return out(a + d[0], r - w * d[1] * (r / D) * f, w, h);
    }
  }

  class CSinShimmerShift extends B.Shift {
    randomizeParams(E) {
      this.dbl[0] = fr(fr(U(E) * 10) - 5);
      var u = U(E); this.dbl[1] = fr(u + u);
      this.dbl[2] = E.rand() % 2;
    }
    map(x, y, E) {
      var d = this.dbl, m = T(d[2]);
      if (m === 0) return R2(x, T(y - ((FX[0] = x * d[1], usin(), FR[0]) + (FX[0] = y * d[1], usin(), FR[0])) * d[0]));
      if (m === 1) return R2(T(x - ((FX[0] = y * d[1], usin(), FR[0]) + (FX[0] = d[1] * x, usin(), FR[0])) * d[0]), y);
      return R2(x, y);
    }
  }

  class CZoomShift extends B.Shift {
    constructor() { super(); this.outOfRangeKeep = false; }
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = fr(fr(U(E) * 0.2) - F_0_1); }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, D = Math.sqrt(w * w + h * h) * 0.5;
      if (D === 0) D = F_1EM4;
      var a = polarA(x, y, w, h), r = polarR(x, y, w, h);
      return out(a + d[0], r - w * d[1] * (r / D), w, h);
    }
  }

  class CTrigStretchShift extends B.Shift {
    constructor() { super(); this.outOfRangeKeep = false; }
    randomizeParams(E) { this.dbl[0] = twist(E); this.dbl[1] = trigAmt(E); this.dbl[2] = E.rand() % 3; this.dbl[3] = fr(U(E) * 0.3); }
    map(x, y, E) {
      var w = E.W, h = E.H, d = this.dbl, D = Math.sqrt(w * w + h * h) * 0.5;   // no zero guard
      var a = polarA(x, y, w, h), r = polarR(x, y, w, h), f = trigf(a, x, T(d[2]));
      var t = r / (w >> 1);
      var rT = r - w * d[1] * (r / D) * f;
      var r2 = ((r - T(h * d[3]) * t * t * t) + rT + rT) / 3.0;
      var ang = (a + d[0] * t + (d[0] + a) + (d[0] + a)) / 3.0;
      return out(ang, r2, w, h);
    }
  }

  class CEdgeFalloffShift extends B.Shift {
    constructor() { super(); this.outOfRangeKeep = false; }
    randomizeParams(E) { this.dbl[0] = fr(U(E) * F_0_1); this.dbl[1] = E.rand() % 4; }
    map(x, y, E) {
      var d = this.dbl, m = T(d[1]), s = d[0] + 1.0, q;
      if (m === 0) return R2(T(s * x), y);
      if (m === 1) return R2(x, T(s * y));
      if (m === 2) { q = E.W - x - 1; return R2(x - T(s * q - q), y); }
      if (m === 3) { q = E.H - y - 1; return R2(x, y - T(s * q - q)); }
      return R2(x, y);
    }
  }

  var all = { CStretchShift: CStretchShift, CStarburstShift: CStarburstShift, CRingSpinShift: CRingSpinShift,
    CSwirlShift: CSwirlShift, CTileShift: CTileShift, CLinearShift: CLinearShift, CTwirlocity: CTwirlocity,
    CShiitake: CShiitake, CThingusShift: CThingusShift, CTrigShift: CTrigShift, CSinShimmerShift: CSinShimmerShift,
    CZoomShift: CZoomShift, CTrigStretchShift: CTrigStretchShift, CEdgeFalloffShift: CEdgeFalloffShift };
  Object.keys(all).forEach(function (n) { B.register(n, all[n]); });
})(B);
if (typeof module !== 'undefined' && module.exports) module.exports = B;
