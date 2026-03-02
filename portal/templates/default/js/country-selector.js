// ── 2. Country selector ────────────────────────────────────────────────────
var COUNTRIES = [
  { code: 'GB', name: 'United Kingdom',   dial: '+44'  },
  { code: 'US', name: 'United States',    dial: '+1'   },
  { code: 'IN', name: 'India',            dial: '+91'  },
  { code: 'AU', name: 'Australia',        dial: '+61'  },
  { code: 'CA', name: 'Canada',           dial: '+1'   },
  { code: 'DE', name: 'Germany',          dial: '+49'  },
  { code: 'FR', name: 'France',           dial: '+33'  },
  { code: 'ES', name: 'Spain',            dial: '+34'  },
  { code: 'IT', name: 'Italy',            dial: '+39'  },
  { code: 'NL', name: 'Netherlands',      dial: '+31'  },
  { code: 'AE', name: 'UAE',              dial: '+971' },
  { code: 'SA', name: 'Saudi Arabia',     dial: '+966' },
  { code: 'SG', name: 'Singapore',        dial: '+65'  },
  { code: 'JP', name: 'Japan',            dial: '+81'  },
  { code: 'CN', name: 'China',            dial: '+86'  },
  { code: 'BR', name: 'Brazil',           dial: '+55'  },
  { code: 'MX', name: 'Mexico',           dial: '+52'  },
  { code: 'ZA', name: 'South Africa',     dial: '+27'  },
  { code: 'NG', name: 'Nigeria',          dial: '+234' },
  { code: 'PK', name: 'Pakistan',         dial: '+92'  },
  { code: 'BD', name: 'Bangladesh',       dial: '+880' },
  { code: 'PH', name: 'Philippines',      dial: '+63'  },
  { code: 'TR', name: 'Turkey',           dial: '+90'  },
  { code: 'PL', name: 'Poland',           dial: '+48'  },
  { code: 'SE', name: 'Sweden',           dial: '+46'  },
  { code: 'NO', name: 'Norway',           dial: '+47'  },
  { code: 'DK', name: 'Denmark',          dial: '+45'  },
  { code: 'CH', name: 'Switzerland',      dial: '+41'  },
  { code: 'NZ', name: 'New Zealand',      dial: '+64'  },
  { code: 'IE', name: 'Ireland',          dial: '+353' },
  { code: 'PT', name: 'Portugal',         dial: '+351' },
  { code: 'RU', name: 'Russia',           dial: '+7'   },
  { code: 'KR', name: 'South Korea',      dial: '+82'  },
  { code: 'EG', name: 'Egypt',            dial: '+20'  },
  { code: 'GH', name: 'Ghana',            dial: '+233' },
  { code: 'KE', name: 'Kenya',            dial: '+254' },
  { code: 'TZ', name: 'Tanzania',         dial: '+255' },
  { code: 'MY', name: 'Malaysia',         dial: '+60'  },
  { code: 'TH', name: 'Thailand',         dial: '+66'  },
  { code: 'VN', name: 'Vietnam',          dial: '+84'  },
  { code: 'ID', name: 'Indonesia',        dial: '+62'  },
  { code: 'HK', name: 'Hong Kong',        dial: '+852' },
  { code: 'QA', name: 'Qatar',            dial: '+974' },
  { code: 'KW', name: 'Kuwait',           dial: '+965' },
  { code: 'BH', name: 'Bahrain',          dial: '+973' },
  { code: 'OM', name: 'Oman',             dial: '+968' },
  { code: 'JO', name: 'Jordan',           dial: '+962' },
  { code: 'LB', name: 'Lebanon',          dial: '+961' },
  { code: 'MA', name: 'Morocco',          dial: '+212' },
  { code: 'TN', name: 'Tunisia',          dial: '+216' },
];

function toFlag(code) {
  return code.toUpperCase().replace(/./g, function(c) {
    return String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0));
  });
}

function renderCountries(q) {
  var list = document.getElementById('countryList');
  var ql = (q || '').toLowerCase();
  var html = '';
  COUNTRIES.forEach(function(c) {
    if (ql && c.name.toLowerCase().indexOf(ql) === -1 && c.dial.indexOf(ql) === -1) return;
    var f = toFlag(c.code);
    html += '<div class="country-option" onclick="selectCountry(\'' +
      c.dial.replace(/'/g,'') + '\',\'' + f + '\')" role="option">' +
      '<span class="opt-flag">' + f + '</span>' +
      '<span class="opt-name">' + c.name + '</span>' +
      '<span class="opt-code">' + c.dial + '</span></div>';
  });
  list.innerHTML = html ||
    '<div style="padding:12px 14px;color:#bbb;font-size:13px">No results</div>';
}

function selectCountry(dial, flag) {
  document.getElementById('selectedFlag').textContent = flag;
  document.getElementById('selectedCode').textContent = dial;
  document.getElementById('f_phoneCountryCode').value = dial;
  closeDropdown();
  document.getElementById('phone').focus();
}

function openDropdown() {
  document.getElementById('countryDropdown').classList.add('open');
  document.getElementById('countryBtn').classList.add('open');
  document.getElementById('countryBtn').setAttribute('aria-expanded', 'true');
  document.getElementById('countrySearch').value = '';
  renderCountries('');
  setTimeout(function() { document.getElementById('countrySearch').focus(); }, 50);
}

function closeDropdown() {
  document.getElementById('countryDropdown').classList.remove('open');
  document.getElementById('countryBtn').classList.remove('open');
  document.getElementById('countryBtn').setAttribute('aria-expanded', 'false');
}

document.getElementById('countryBtn').addEventListener('click', function(e) {
  e.stopPropagation();
  document.getElementById('countryDropdown').classList.contains('open')
    ? closeDropdown() : openDropdown();
});
document.getElementById('countrySearch').addEventListener('input', function() {
  renderCountries(this.value);
});
document.addEventListener('click', function(e) {
  if (!document.getElementById('phoneWrapper').contains(e.target)) closeDropdown();
});
renderCountries('');
