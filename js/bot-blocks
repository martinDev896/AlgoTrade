// ==========================================================
// AlgoTrade — bot-blocks.js
// Custom Blockly blocks for the Bot Builder, plus their JavaScript
// code generators. Built-in Blockly blocks (Logic, Loops, Math,
// Variables) are added via  toolbox in index.html — only the
// trading-specific blocks are defined here.
//
// Every generated statement is `await`-ed, so the whole program runs
// as one async function body (see bot-runtime.js's Run handler).
// ==========================================================

// ---------- When Run (the starting block) ----------
Blockly.Blocks['when_run'] = {
  init: function () {
    this.appendDummyInput().appendField('▶ When Run');
    this.appendStatementInput('DO');
    this.setColour(45);
    this.setTooltip('The bot starts executing from here.');
  },
};
Blockly.JavaScript['when_run'] = function (block) {
  return Blockly.JavaScript.statementToCode(block, 'DO');
};

// ---------- Purchase: Rise/Fall ----------
Blockly.Blocks['purchase_rise_fall'] = {
  init: function () {
    this.appendDummyInput()
      .appendField('Purchase')
      .appendField(new Blockly.FieldDropdown([['Rise', 'CALL'], ['Fall', 'PUT']]), 'CONTRACT');
    this.appendDummyInput()
      .appendField('Duration')
      .appendField(new Blockly.FieldNumber(5, 1), 'DURATION')
      .appendField(new Blockly.FieldDropdown([['Ticks', 't'], ['Seconds', 's'], ['Minutes', 'm']]), 'UNIT');
    // A VALUE input (not a plain field) — a number can be plugged in
    // directly, but so can a variable or a math expression, which is
    // what actually makes martingale-style dynamic staking possible.
    this.appendValueInput('STAKE').setCheck('Number').appendField('Stake');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(160);
    this.setTooltip('Buy a Rise/Fall contract on the currently selected market and wait for it to settle. Plug a variable into Stake for martingale-style staking.');
  },
};
Blockly.JavaScript['purchase_rise_fall'] = function (block) {
  const contract = block.getFieldValue('CONTRACT');
  const duration = block.getFieldValue('DURATION');
  const unit = block.getFieldValue('UNIT');
  const stake = Blockly.JavaScript.valueToCode(block, 'STAKE', Blockly.JavaScript.ORDER_NONE) || '1';
  return `await BotRuntime.purchase(${JSON.stringify(contract)}, { duration: ${duration}, duration_unit: ${JSON.stringify(unit)}, amount: ${stake} });\n`;
};

// ---------- Purchase: Digits ----------
Blockly.Blocks['purchase_digits'] = {
  init: function () {
    this.appendDummyInput()
      .appendField('Purchase')
      .appendField(new Blockly.FieldDropdown([
        ['Matches', 'DIGITMATCH'], ['Differs', 'DIGITDIFF'],
        ['Over', 'DIGITOVER'], ['Under', 'DIGITUNDER'],
        ['Even', 'DIGITEVEN'], ['Odd', 'DIGITODD'],
      ]), 'CONTRACT')
      .appendField('digit')
      .appendField(new Blockly.FieldNumber(5, 0, 9, 1), 'DIGIT');
    this.appendDummyInput()
      .appendField('Duration')
      .appendField(new Blockly.FieldNumber(5, 1), 'DURATION')
      .appendField(new Blockly.FieldDropdown([['Ticks', 't'], ['Seconds', 's'], ['Minutes', 'm']]), 'UNIT');
    this.appendValueInput('STAKE').setCheck('Number').appendField('Stake');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(210);
    this.setTooltip('Buy a Digits contract. "digit" is ignored for Even/Odd. Plug a variable into Stake for martingale-style staking.');
  },
};
Blockly.JavaScript['purchase_digits'] = function (block) {
  const contract = block.getFieldValue('CONTRACT');
  const digit = block.getFieldValue('DIGIT');
  const duration = block.getFieldValue('DURATION');
  const unit = block.getFieldValue('UNIT');
  const stake = Blockly.JavaScript.valueToCode(block, 'STAKE', Blockly.JavaScript.ORDER_NONE) || '1';
  const needsBarrier = contract !== 'DIGITEVEN' && contract !== 'DIGITODD';
  const barrierPart = needsBarrier ? `, barrier: ${digit}` : '';
  return `await BotRuntime.purchase(${JSON.stringify(contract)}, { duration: ${duration}, duration_unit: ${JSON.stringify(unit)}, amount: ${stake}${barrierPart} });\n`;
};

// ---------- Purchase: Accumulator ----------
// Accumulators have no fixed expiry, so a bot needs an explicit exit —
// this block auto-sells after the given number of ticks.
Blockly.Blocks['purchase_accumulator'] = {
  init: function () {
    this.appendDummyInput()
      .appendField('Purchase Accumulator, growth')
      .appendField(new Blockly.FieldDropdown([['1%', '0.01'], ['2%', '0.02'], ['3%', '0.03'], ['4%', '0.04'], ['5%', '0.05']]), 'GROWTH');
    this.appendDummyInput()
      .appendField('Hold for')
      .appendField(new Blockly.FieldNumber(10, 1), 'HOLD_TICKS')
      .appendField('ticks, then sell');
    this.appendValueInput('STAKE').setCheck('Number').appendField('Stake');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(290);
    this.setTooltip('Buy an Accumulator and automatically sell it after the given number of ticks. Plug a variable into Stake for martingale-style staking.');
  },
};
Blockly.JavaScript['purchase_accumulator'] = function (block) {
  const growth = block.getFieldValue('GROWTH');
  const holdTicks = block.getFieldValue('HOLD_TICKS');
  const stake = Blockly.JavaScript.valueToCode(block, 'STAKE', Blockly.JavaScript.ORDER_NONE) || '1';
  return `await BotRuntime.purchaseAccumulator({ growth_rate: ${growth}, amount: ${stake}, holdTicks: ${holdTicks} });\n`;
};

// ---------- Stop Bot (statement) ----------
// Lets strategy logic stop itself, e.g. "if total profit < -10 then Stop Bot" —
// distinct from the toolbar's Stop button, which is the user stopping it.
Blockly.Blocks['stop_bot'] = {
  init: function () {
    this.appendDummyInput().appendField('⏹ Stop Bot');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(0);
    this.setTooltip('Stops the bot — use inside an "if" block for stop-loss/take-profit logic.');
  },
};
Blockly.JavaScript['stop_bot'] = () => 'BotRuntime.stop();\n';

// ---------- Value blocks: read live market/trade state ----------
function defineValueBlock(type, label, outputType) {
  Blockly.Blocks[type] = {
    init: function () {
      this.appendDummyInput().appendField(label);
      this.setOutput(true, outputType);
      this.setColour(45);
    },
  };
}

defineValueBlock('current_price_value', 'current price', 'Number');
Blockly.JavaScript['current_price_value'] = () => ['BotRuntime.getCurrentPrice()', Blockly.JavaScript.ORDER_ATOMIC];

defineValueBlock('last_digit_value', 'last digit', 'Number');
Blockly.JavaScript['last_digit_value'] = () => ['BotRuntime.getLastDigit()', Blockly.JavaScript.ORDER_ATOMIC];

defineValueBlock('last_trade_won_value', 'last trade won', 'Boolean');
Blockly.JavaScript['last_trade_won_value'] = () => ['BotRuntime.lastTradeWon()', Blockly.JavaScript.ORDER_ATOMIC];

defineValueBlock('last_trade_profit_value', 'last trade profit', 'Number');
Blockly.JavaScript['last_trade_profit_value'] = () => ['BotRuntime.lastTradeProfit()', Blockly.JavaScript.ORDER_ATOMIC];

defineValueBlock('total_profit_value', 'total profit', 'Number');
Blockly.JavaScript['total_profit_value'] = () => ['BotRuntime.getTotalProfit()', Blockly.JavaScript.ORDER_ATOMIC];
