
//register settings
Hooks.once("init", () => {
  game.settings.register("combat-narration", "suppressDebug", {
    name: "Suppress Debug Output",
    hint: "If enabled, this module will stop printing debug logs to the console.",
    scope: "client",          // each user can choose independently
    config: true,             // show in module settings UI
    type: Boolean,
    default: true,
    onChange: value => { // Optional: Runs when value changes
      console.log(`My setting changed to: ${value}`);
    },
    requiresReload: true // Optional: If true, requires a reload to take effect
  });
});


const NARRATION_PRE_ROLL_STATUSES = new Map();

Hooks.on("midi-qol.preAttackRollComplete", async (workflow) => {
  const targets = workflow.targets ? [...workflow.targets] : [];

  for (const target of targets) {
    const key = `${workflow.id}.${target.id}`;
    NARRATION_PRE_ROLL_STATUSES.set(key, new Set(target.actor?.statuses ?? []));
  }
});



//helpers
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function narrateLog(...args) {
  const suppress = game.settings.get("combat-narration", "suppressDebug");
  if (!suppress) console.log(...args);
}

function narrateWarn(...args) {
  const suppress = game.settings.get("combat-narration", "suppressDebug");
  if (!suppress) console.warn(...args);
}

function collectDamageTypesFromObject(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return found;

  if (typeof obj.type === "string") {
    const type = obj.type.toLowerCase();
    if ([
      "acid", "bludgeoning", "cold", "fire", "force",
      "lightning", "necrotic", "piercing", "poison",
      "psychic", "radiant", "slashing", "thunder"
    ].includes(type)) {
      found.add(type);
    }
  }

  if (obj.types instanceof Set) {
    for (const type of obj.types) found.add(String(type).toLowerCase());
  }

  if (Array.isArray(obj.types)) {
    for (const type of obj.types) found.add(String(type).toLowerCase());
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      collectDamageTypesFromObject(value, found);
    }
  }

  return found;
}

function normalizeConditionValue(raw) {
  if (raw == null) return [];

  // Handle array/set directly
  if (Array.isArray(raw)) return raw.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  if (raw instanceof Set) return [...raw].map(v => String(v).trim().toLowerCase()).filter(Boolean);

  // Handle comma/semicolon separated strings
  if (typeof raw === "string") {
    return raw
      .split(/[,;]+/)
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);
  }

  return [String(raw).trim().toLowerCase()].filter(Boolean);
}

function getActorConditionImmunities(actor) {
  const immunities = new Set();

  if (!actor) return immunities;

  // 1. Native actor condition immunities from sheet/data
  const nativeCI = actor.system?.traits?.ci?.value;
  for (const value of normalizeConditionValue(nativeCI)) {
    immunities.add(value);
  }

  // 2. Active effects that add condition immunities
  for (const effect of actor.effects ?? []) {
    for (const change of effect.changes ?? []) {
      if (change.key !== "system.traits.ci.value") continue;

      for (const value of normalizeConditionValue(change.value)) {
        immunities.add(value);
      }
    }
  }

  return immunities;
}

function itemAppliesCondition(workflow, conditionName) {
  const targetCondition = String(conditionName).toLowerCase();

  // Check statuses on item effects
  for (const effect of workflow.item?.effects ?? []) {
    for (const status of effect.statuses ?? []) {
      if (String(status).toLowerCase() === targetCondition) return true;
    }
  }

  // Check AE changes on item effects too, in case statuses are not populated
  for (const effect of workflow.item?.effects ?? []) {
    for (const change of effect.changes ?? []) {
      if (!change.key?.includes("status")) continue;
      const values = normalizeConditionValue(change.value);
      if (values.includes(targetCondition)) return true;
    }
  }

  return false;
}

async function playAudio(key) {

  // Ensure the cache exists ASAP
  if (!game.combatNarrationCache) game.combatNarrationCache = {};

  const folderPath = `modules/combat-narration/sounds/`;
  const files = await foundry.applications.apps.FilePicker.implementation.browse("data", folderPath);

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactPattern = new RegExp(`^${escapedKey}_(\\d+)\\.ogg$`, "i");

  const matchingFiles = files.files.filter(f => {
    const fileName = f.split("/").pop();
    return exactPattern.test(fileName);
  });

  narrateLog(`🎧 Found ${matchingFiles.length} files for key "${key}".`);

  if (matchingFiles.length === 0) {
    console.warn(`⚠️ No matching hit audio files found for key "${key}".`);
    return;
  }

  let lastUsed = game.combatNarrationCache[key] ?? null;
  let variation = null;
  let attempts = 0;

  do {
    const randomIndex = Math.floor(Math.random() * matchingFiles.length);
    const fileName = matchingFiles[randomIndex].split("/").pop();
    const match = fileName.match(exactPattern);
    variation = match?.[1] ?? null;
    attempts++;
  } while (variation === lastUsed && attempts < 10);

  game.combatNarrationCache[key] = variation;

  const filePath = `${folderPath}${key}_${variation}.ogg`;
  narrateLog(`🔊 Playing audio: ${filePath}`);

  await foundry.audio.AudioHelper.play(
    { src: filePath, volume: 1.0, autoplay: true, loop: false },
    true
  );
}


Hooks.on("midi-qol.RollComplete", async (workflow) => {
    narrateLog("🗡️ Combat Narration Hook Triggered");

    const item = workflow.item;
    const actor = item?.actor;
    const hitTargets = [...workflow.hitTargets];
    const damageDetails = workflow.damageDetail;

    const hasHealing = Array.isArray(damageDetails) &&
    damageDetails.some(d => String(d.type ?? "").toLowerCase() === "healing");

    if (hasHealing) {
      narrateLog("Healing detected in damageDetail, skipping combat narration so it can be handled by preUpdateActor hook", damageDetails);
      return;
    }

    //healing is handled in preUpateActor hook
    const isHealActivity = workflow.activity?.type === "heal";
    if (isHealActivity) {
      narrateLog(`[Combat Narration] Healing workflow detected for ${item?.name}, skipping RollComplete narration.`);
      return;
    }


  /*
  // PRINT EVERYTHING
  narrateLog("hitTargets:", workflow.hitTargets ? [...workflow.hitTargets] : []);
  narrateLog("targets:", workflow.targets ? [...workflow.targets] : []);
  narrateLog("_targets:", workflow._targets ? [...workflow._targets] : []);
  narrateLog("failedSaves:", workflow.failedSaves ? [...workflow.failedSaves] : []);
  narrateLog("preSelectedTargets:", workflow.preSelectedTargets ? [...workflow.preSelectedTargets] : []);
  */

  // TURN EVERYTHING INTO ARRAYS
  const pools = [
    workflow.hitTargets ? [...workflow.hitTargets] : [],
    workflow.preSelectedTargets ? [...workflow.preSelectedTargets] : [],
    Array.isArray(workflow.targets) ? workflow.targets : [],
    workflow._targets ? [...workflow._targets] : [],
    workflow.failedSaves ? [...workflow.failedSaves] : []
  ];

  let NARRATION_INTERNAL_TARGET = null;

  // LOOP OVER ALL POOLS UNTIL WE FIND A TOKEN
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    if (pool && pool.length > 0) {
      NARRATION_INTERNAL_TARGET = pool[0];
      narrateLog(`🎯 Selected target from pool index ${i}:`, NARRATION_INTERNAL_TARGET);
      break;
    }
  }

  narrateLog("🎯 Final chosen target:", NARRATION_INTERNAL_TARGET);

  // VALIDATE
  if (!NARRATION_INTERNAL_TARGET || typeof NARRATION_INTERNAL_TARGET.x !== "number") {
    console.warn("❌ NO VALID TARGET FOUND WITH COORDINATES.", NARRATION_INTERNAL_TARGET);
    return;
  }

  narrateLog("✔ Target has coords:", NARRATION_INTERNAL_TARGET.x, NARRATION_INTERNAL_TARGET.y);

  // Now safe to compute distance/path
  const attacker = workflow.token;
  // 1. Horizontal distance along grid
  const path = [{ x: attacker.x, y: attacker.y }, { x: NARRATION_INTERNAL_TARGET.x, y: NARRATION_INTERNAL_TARGET.y }];

  const gridDistance = canvas.grid.measurePath(path).distance;

  // 2. Vertical elevation difference
  const dz = (NARRATION_INTERNAL_TARGET.document.elevation ?? 0) - (attacker.document.elevation ?? 0);

  // 3. True 3D distance
  const distance3D = Math.hypot(gridDistance, dz);
  narrateLog(`🗡️ [Combat Narration] Distance (3D): ${distance3D.toFixed(1)} ft`);

  // Check if this item actually rolled an attack or did damage
  const hasAttackRoll = workflow.attackRoll != null;
  const hasRealDamage =
    !!workflow.damageRoll ||
    (Array.isArray(workflow.damageRolls) && workflow.damageRolls.length > 0) ||
    (Array.isArray(workflow.damageDetail) && workflow.damageDetail.length > 0) ||
    (typeof workflow.damageTotal === "number" && workflow.damageTotal > 0);

  const hasAttack = hasAttackRoll || hasRealDamage;

  // Optional: Check if the item has a defined action type
  const isAttackAction = workflow.activity?.type === "attack";

  const isSaveSpell = workflow.saveDC !== undefined;
  narrateLog(workflow);

  if(!isSaveSpell && !isAttackAction && !hasAttack){
    console.warn("⚠️ [Combat Narration] Not an attack or save spell");
    //narrateLog(workflow);
    return;
  }

  const properties = item.system?.properties;
  const isAmmo = properties?.has("amm");
  const isThrown = properties?.has("thr");
  const isFearSpell = itemAppliesCondition(workflow, "frightened");

  let damageTypes = new Set();

  // ✅ 1. Modern (DnD5e 4.x) activity-based types
  const activities = Object.values(item.system?.activities || {});
  for (const act of activities) {
    if (!act.damage?.parts) continue;
    for (const part of act.damage.parts) {
      for (const dmg of part.types || []) {
        damageTypes.add(dmg.toLowerCase());
      }
    }
  }

  // ✅ 2. Legacy weapon support
  const legacyTypes = item?.system?.damage?.base?.types;
  if (legacyTypes && legacyTypes instanceof Set) {
    for (const type of legacyTypes) {
      damageTypes.add(type.toLowerCase());
    }
  }

  // ✅ 3. Fallback: some spells still use item.system.damage.parts directly
  const fallbackParts = item.system?.damage?.parts || [];
  for (const [formula, type] of fallbackParts) {
    if (type) damageTypes.add(type.toLowerCase());
  }

  // Modern dnd5e / Midi fallback: crawl activity + item damage structures
  collectDamageTypesFromObject(workflow.activity, damageTypes);
  collectDamageTypesFromObject(workflow.item?.system?.activities, damageTypes);
  collectDamageTypesFromObject(workflow.item?.system?.damage, damageTypes);

  if (workflow.defaultDamageType) {
    damageTypes.add(String(workflow.defaultDamageType).toLowerCase());
  }

  narrateLog("🎯 Collected Damage Types:", [...damageTypes]);


  // 🪄 Skip hit/miss narration for non-damaging spells
  const workflowRepresentsDamagingAction =
  !!workflow?.damageRoll ||
  (Array.isArray(workflow?.damageRolls) && workflow.damageRolls.length > 0) ||
  (Array.isArray(workflow?.damageDetail) && workflow.damageDetail.length > 0) ||
  !!workflow?.defaultDamageType;

  if (item.type === "spell" && !workflowRepresentsDamagingAction && !isFearSpell) {
    narrateLog(`🪄 [Spell Narration] ${item.name} produced no damaging action in workflow, skipping combat narration`);
    return;
  }

  const elementalTypes = ["fire", "cold", "lightning", "acid", "necrotic", "radiant", "force", "psychic", "thunder"];
  const physicalTypes = ["slashing", "piercing", "bludgeoning"];
  const SLASHING_HINTS = [
    "sword", "axe", "scimitar",
    "claw", "claws", "rend", "rake", "scratch",
    "talon", "talons",
    "lash", "whip", "tendril"
  ];
  const PIERCING_HINTS = [
    "dagger", "spear", "rapier",
    "bite", "bites", "sting", "gore",
    "horn", "horns", "tusk", "tusks",
    "fang", "fangs", "beak",
    "spike", "spikes", "quill", "quills"
  ];
  const BLUDGEONING_HINTS = [
    "mace", "hammer", "club",
    "slam", "tail", "fist",
    "bash", "crush"
  ];

  // Unified weaponType logic
  let weaponType = null;

  for (const type of damageTypes) {
    if (elementalTypes.includes(type)) {
      weaponType = type;
      break;
    }
  }
  if (!weaponType) {
    for (const type of damageTypes) {
      if (physicalTypes.includes(type)) {
        weaponType = type;
        break;
      }
    }
  }

  // Overrides (for ammo/thrown weapons)
  if (isAmmo){
     weaponType = "bow";
  }
  else if (isThrown){
    //a weapon may have thrown property but you're still using it as melee since the target is close.
    if(distance3D > 6){
      weaponType = "thrown";
    } 
  } 

  narrateLog("🎯 weaponType:", weaponType);
  narrateLog("🎯 saveResults:", workflow.saveResults);

  narrateLog("🎯 isFearSpell:", isFearSpell);
  if(isFearSpell){
    weaponType = "fear";
  }

  // Fallback based on name
  const name = item.name.toLowerCase();
  narrateLog("Weapon Name:", name);
  
  if (name === "claws" || name === "claw" || name === "rend" || name === "rake" || name === "scratch" || name === "talons" || name === "talon") {
    weaponType = Math.random() < .65 ? "claws" : weaponType;
  }
  else if (name === "bite" || name === "bites" || name.endsWith("bite")) {
    weaponType = Math.random() < .65 ? "bite" : weaponType;
  }
  else if (isAmmo || name.includes("bow") || name.includes("arrow")) {
    weaponType = "bow";
  }
  else if (!weaponType) {
    if (SLASHING_HINTS.some(hint => name.includes(hint))) {
      weaponType = "slashing";
    } else if (PIERCING_HINTS.some(hint => name.includes(hint))) {
      weaponType = "piercing";
    } else if (BLUDGEONING_HINTS.some(hint => name.includes(hint))) {
      weaponType = "bludgeoning";
    } else if (name.includes("lunar") || name.includes("lightburst")) {
      weaponType = "radiant";
    } else if (name.includes("flaming") || name.includes("explosive") || name.includes("fire") || name.includes("flame")) {
      weaponType = "fire";
    } else if (name.includes("thunder")) {
      weaponType = "thunder";
    } else {
      weaponType = "bludgeoning";
    }
  }

  //determine the type of damage with the greatest value
  let highest = { type: null, amount: 0 };
  if(damageDetails){
    for (let d of damageDetails) {
    narrateLog(`➕ Damage detail: ${d.type} - ${d.damage}`);
    if (d.damage > highest.amount) highest = { type: d.type, amount: d.damage };
    }
  }
  
  
  // 🔁 Override weaponType based on actual damage dealt only if current weaponType is bludgeoning (our fallback). Only run this code if it's a hit.
  if(weaponType == "bludgeoning" && damageDetails){
    const actualDamageType = highest.type?.toLowerCase?.();
    if (actualDamageType) {
      if (elementalTypes.includes(actualDamageType)) {
        weaponType = actualDamageType;
      } else if (physicalTypes.includes(actualDamageType)) {
        weaponType = actualDamageType;
      } else {
        // If it's not a known type, keep existing value or fallback to bludgeoning
        weaponType = weaponType || "bludgeoning";
      }
      narrateLog(`🧬 Overriding weaponType based on damageDetail: ${weaponType}`);
    }
  }

  narrateLog("🎯 Final weaponType:", weaponType);

  const folderPath = `modules/combat-narration/sounds/`;

  // 🟥 MISS HANDLING
 // 🟥 MISS / SAVE SUCCESS / CONDITION IMMUNITY HANDLING
if (hitTargets.length === 0 || (isSaveSpell && workflow.failedSaves?.size === 0)) {
  narrateLog("❌ [Combat Narration] Attack missed or save spell had no failed saves.");

  let key = `${weaponType}_miss`;

  // For fear spells, distinguish between normal success and immunity
  if (isFearSpell) {
    const possibleTargets = [
      ...(workflow.hitTargets ? [...workflow.hitTargets] : []),
      ...(workflow.preSelectedTargets ? [...workflow.preSelectedTargets] : []),
      ...(Array.isArray(workflow.targets) ? workflow.targets : []),
      ...(workflow._targets ? [...workflow._targets] : [])
    ];

    const targetForImmunityCheck = possibleTargets[0];

    if (!targetForImmunityCheck?.actor) {
      narrateWarn("⚠️ [Combat Narration] No target actor found for fear immunity check.");
      key = `${weaponType}_success`;
    } else {
      const conditionImmunities = getActorConditionImmunities(targetForImmunityCheck.actor);
      const isImmuneToFear = conditionImmunities.has("frightened");

      narrateLog(`📌 Target Condition Immunities: ${[...conditionImmunities]}`);
      narrateLog(`📌 Is immune to frightened: ${isImmuneToFear}`);

      // If the spell failed because of immunity, use not_effective if you have it.
      // Otherwise fall back to success.
      key = isImmuneToFear ? `${weaponType}_not_effective` : `${weaponType}_success`;
    }
  }

  await playAudio(key);
  return;
}

  // ✅ HIT HANDLING
  const target = hitTargets[0];
  const targetMaxHP = target.actor.system.attributes.hp.max + target.actor.system.attributes.hp.temp;
  const targetHP = target.actor.system.attributes.hp.value + target.actor.system.attributes.hp.temp;
  narrateLog(`📌 Target Immunities: ${[...target.actor.system.traits.di.value]}`);
  narrateLog(`📌 Target Vulnerabilties: ${[...target.actor.system.traits.dv.value]}`);
  narrateLog(`📌 Target Resistances: ${[...target.actor.system.traits.dr.value]}`);

  const isImmune = [...target.actor.system.traits.di.value].includes(weaponType);
  const isVulnerable = [...target.actor.system.traits.dv.value].includes(weaponType);
  const isResistant = [...target.actor.system.traits.dr.value].includes(weaponType);
  let totalDamage = workflow.damageTotal;

  if(isVulnerable){
    totalDamage = workflow.damageTotal * 2;
  }
  else if(isResistant){
    totalDamage = workflow.damageTotal / 2;
  }
  else if(isImmune){
    totalDamage = 0;
  }

  const preHP = targetHP + totalDamage;
  const postHP = targetHP;

  narrateLog(`📌 Actor: ${actor.name}, Target: ${target.name}`);
  narrateLog(`🧮 Target HP: ${preHP} → ${postHP}`);

  //determine severity
  let severity = "minor";
  totalDamage = preHP - postHP;

  if (postHP <= 0) {
    severity = "death";
  } 
  else if(isFearSpell){
    severity = "fail";
  }
  else if (totalDamage == 0){
    severity = "not_effective";
  }
  else {
    const ratio = totalDamage / targetMaxHP;
    if (ratio > 0.2) severity = "severe";
    else if (ratio > 0.1) severity = "moderate";
  }

  let key = `${weaponType}_${severity}`;

  //Monster specific hit handling
  //only run if target is not immune
  if(!isImmune){
    const targetNameLower = target.name.toLowerCase();
  
    let monsterSpecific = null;

    if (targetNameLower.includes("dragon")) {
      monsterSpecific = `dragon_${severity}`;
    } else if (targetNameLower.includes("air elemental")) {
      monsterSpecific = `air_elemental_${severity}`;
    } else if (targetNameLower.includes("earth elemental")) {
      monsterSpecific = `earth_elemental_${severity}`;
    } else if (targetNameLower.includes("fire elemental")) {
      monsterSpecific = `fire_elemental_${severity}`;
    } else if (targetNameLower.includes("water elemental")) {
      monsterSpecific = `water_elemental_${severity}`;
    }

    if(monsterSpecific != null){
      //even if monster specific found, only use monster specific key 85% of the time
      if (Math.random() < .85) {
        key = monsterSpecific;
      }
      else{
        key = `${weaponType}_${severity}`;
      }
    }
  }
  

  // condition specific handling
const SUPPORTED_CONDITIONS = new Set([
  "blinded",
  "charmed",
  "deafened",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "exhausted"
]);

const newlyAppliedConditions = new Set();

const preStatusKey = `${workflow.id}.${target.id}`;
const preStatuses = NARRATION_PRE_ROLL_STATUSES.get(preStatusKey) ?? new Set();
const postStatuses = new Set(target.actor?.statuses ?? []);

for (const status of postStatuses) {
  const normalized = String(status).toLowerCase();

  if (!preStatuses.has(status)) {
    newlyAppliedConditions.add(normalized);
  }
}

NARRATION_PRE_ROLL_STATUSES.delete(preStatusKey);

const targetConditionImmunities = getActorConditionImmunities(target.actor);

const matchedConditions = [...newlyAppliedConditions].filter(c =>
  SUPPORTED_CONDITIONS.has(c) &&
  !targetConditionImmunities.has(c)
);

const blockedConditions = [];

narrateLog(`🔥 Pre Statuses: ${[...preStatuses]}`);
narrateLog(`🔥 Post Statuses: ${[...postStatuses]}`);
narrateLog(`🔥 Newly Applied Conditions: ${[...newlyAppliedConditions]}`);
narrateLog(`🔥 Blocked Conditions By Immunity: ${blockedConditions}`);
narrateLog(`🔥 Matched Conditions: ${matchedConditions}`);
narrateLog(`🔥 First Matched Conditions: ${matchedConditions.at(0)}`);

  // PRIORITY ORDER:
// 1. death
// 2. blocked by immunity
// 3. applied condition
// 4. fallback narration

if (severity === "death") {
  narrateLog(`🔥 filename key: ${key}`);
  await playAudio(key);
}
else if (blockedConditions.length > 0) {
  const blockedCondition = blockedConditions.at(0);
  narrateLog(`🔥 Condition blocked by immunity: ${blockedCondition}`);

  let immuneKey = `${weaponType}_not_effective`;

  narrateLog(`🔥 Playing immunity key: ${immuneKey}`);
  await playAudio(immuneKey);
}
else if (matchedConditions.length > 0) {
  narrateLog(`🔥 Playing condition key: ${matchedConditions.at(0)}`);
  await playAudio(matchedConditions.at(0));
}
else {
  narrateLog(`🔥 filename key: ${key}`);
  await playAudio(key);
}

  



    
  
  
  



});

//handle revive logic
Hooks.on("preUpdateActor", async (actor, update, options, userId) => {

  const oldHp = actor.system?.attributes?.hp?.value;
  const newHp = foundry.utils.getProperty(update, "system.attributes.hp.value");

  // Ignore updates that do not actually change HP
  if (typeof newHp !== "number"){
    return;
  } 

  const isRevived = oldHp === 0 && newHp > 0;

  if(isRevived){
    narrateLog(`🔥 filename key: revived`);
    await playAudio("revived");
    return;
  }

  const isHealed = newHp > oldHp;

  if(isHealed){
    const maxHP = actor.system.attributes.hp.max;
    const missingHP = maxHP - oldHp;
    const healAmount = newHp - oldHp;
    const healedPercent = healAmount / missingHP;

    if(healedPercent < .3){
      narrateLog(`🔥 filename key: heal_minor`);
      await playAudio("heal_minor");
    }
    else if (healedPercent < .7){
      narrateLog(`🔥 filename key: heal_moderate`);
      await playAudio("heal_moderate");
    }
    else{
      narrateLog(`🔥 filename key: heal_severe`);
      await playAudio("heal_severe");
    }

  }

  
});
