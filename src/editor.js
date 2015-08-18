"use strict";

/*
 * Sir Trevor Editor
 * --
 * Represents one Sir Trevor editor instance (with multiple blocks)
 * Each block references this instance.
 * BlockTypes are global however.
 */

var _ = require('./lodash');
var config = require('./config');
var utils = require('./utils');
var Dom = require('./packages/dom');

var Events = require('./events');
var EventBus = require('./event-bus');
var BlockControls = require('./block-controls');
var BlockManager = require('./block-manager');
var FloatingBlockControls = require('./floating-block-controls');
var FormatBar = require('./format-bar');
var EditorStore = require('./extensions/editor-store');
var ErrorHandler = require('./error-handler');
var FormEvents = require('./helpers/form-events');

var Editor = function(options) {
  this.initialize(options);
};

Object.assign(Editor.prototype, require('./function-bind'), require('./events'), {

  bound: ['hideAllTheThings', 'changeBlockPosition',
    'removeBlockDragOver', 'renderBlock', 'resetBlockControls',
    'blockLimitReached', 'process'],

  events: {
    'block:reorder:dragend': 'removeBlockDragOver',
    'block:reorder:dropped': 'removeBlockDragOver',
    'block:content:dropped': 'removeBlockDragOver'
  },

  initialize: function(options) {
    utils.log("Init SirTrevor.Editor");

    this.options = Object.assign({}, config.defaults, options || {});

    if (!this._ensureAndSetElements()) { return false; }

    this.options.data = this.options.data || this.el.value;

    if(!_.isUndefined(this.options.onEditorRender) &&
       _.isFunction(this.options.onEditorRender)) {
      this.onEditorRender = this.options.onEditorRender;
    }

    // Mediated events for *this* Editor instance
    this.mediator = Object.assign({}, Events);

    this._bindFunctions();

    this.build();

    if (this.options.formEvents && !this.formEvents) {
      this.formEvents = new FormEvents(this, this.options);
    }

    this.mediator.trigger('initialize');
  },

  /*
   * Build the Editor instance.
   * Check to see if we've been passed JSON already, and if not try and
   * create a default block.
   * If we have JSON then we need to build all of our blocks from this.
   */
  build: function() {
    Dom.hide(this.el);
    
    this.errorHandler = new ErrorHandler(this.outer, this.mediator, this.options.errorsContainer);
    this.store = new EditorStore(this.options.data, this.mediator);
    this.block_manager = new BlockManager(this.options, this.mediator);
    this.block_controls = new BlockControls(this.block_manager.blockTypes, this.mediator);
    this.fl_block_controls = new FloatingBlockControls(this.wrapper, this.mediator);
    this.formatBar = new FormatBar(this.options.formatBar, this.mediator, this);

    this.mediator.on('block:changePosition', this.changeBlockPosition);
    this.mediator.on('block-controls:reset', this.resetBlockControls);
    this.mediator.on('block:limitReached', this.blockLimitReached);
    this.mediator.on('block:render', this.renderBlock);

    this.dataStore = "Please use store.retrieve();";

    this._setEvents();

    this.wrapper.insertBefore(this.fl_block_controls.render().el, this.wrapper.firstChild);
    this.outer.appendChild(this.block_controls.render().el);

    window.addEventListener('click', this.hideAllTheThings);

    this.createBlocks();
    this.wrapper.classList.add('st-ready');

    if(!_.isUndefined(this.onEditorRender)) {
      this.onEditorRender();
    }
  },

  createBlocks: function() {
    var store = this.store.retrieve();

    if (store.data.length > 0) {
      store.data.forEach(function(block) {
        this.mediator.trigger('block:create', block.type, block.data);
      }, this);
    } else if (this.options.defaultType !== false) {
      this.mediator.trigger('block:create', this.options.defaultType, {});
    }
  },

  destroy: function() {
    // Destroy the rendered sub views
    this.formatBar.destroy();
    this.fl_block_controls.destroy();
    this.block_controls.destroy();

    // Destroy all blocks
    this.block_manager.blocks.forEach(function(block) {
      this.mediator.trigger('block:remove', block.blockID);
    }, this);

    this.mediator.trigger('destroy');

    // Stop listening to events
    this.mediator.stopListening();
    this.stopListening();

    // Clear the store
    this.store.reset();
    Dom.replaceWith(this.outer, this.el);
  },

  reinitialize: function(options) {
    this.destroy();
    this.initialize(options || this.options);
  },

  resetBlockControls: function() {
    this.block_controls.renderInContainer(this.wrapper);
    this.block_controls.hide();
  },

  blockLimitReached: function(toggle) {
    this.wrapper.classList.toggle('st--block-limit-reached', toggle);
  },

  _setEvents: function() {
    Object.keys(this.events).forEach(function(type) {
      EventBus.on(type, this[this.events[type]], this);
    }, this);
  },

  hideAllTheThings: function(e) {
    this.block_controls.hide();
    this.formatBar.hide();
  },

  store: function(method, options){
    utils.log("The store method has been removed, please call store[methodName]");
    return this.store[method].call(this, options || {});
  },

  renderBlock: function(block) {
    this._renderInPosition(block.render().el);
    this.hideAllTheThings();

    block.trigger("onRender");
  },

  removeBlockDragOver: function() {
    this.outer.querySelector('.st-drag-over').classList.remove('st-drag-over');
  },

  changeBlockPosition: function(block, selectedPosition) {
    selectedPosition = selectedPosition - 1;

    var blockPosition = this.getBlockPosition(block),
    blockBy = this.wrapper.querySelectorAll('.st-block')[selectedPosition];
    
    if(blockBy && blockBy.getAttribute('id') !== block.getAttribute('id')) {
      this.hideAllTheThings();
      if (blockPosition > selectedPosition) {
        blockBy.parentNode.insertBefore(block, blockBy);
      } else {
        Dom.insertAfter(block, blockBy);
      }
    }
  },

  _renderInPosition: function(block) {
    if (this.block_controls.currentContainer) {
      this.block_controls.currentContainer.insertAdjacentElement('afterend', block);
    } else {
      this.wrapper.appendChild(block);
    }
  },

  validateAndSaveBlock: function(block, shouldValidate) {
    if ((!config.skipValidation || shouldValidate) && !block.valid()) {
      this.mediator.trigger('errors:add', { text: _.result(block, 'validationFailMsg') });
      utils.log("Block " + block.blockID + " failed validation");
      return;
    }

    var blockData = block.getData();
    utils.log("Adding data for block " + block.blockID + " to block store:",
              blockData);
    this.store.addData(blockData);
  },

  /*
   * Returns a promise which resolves when all queued items have been resolved.
   * @param {Boolean} shouldValidate
   * @returns {Promise} Object contains the data and errors from the editor
   */
  process: function(shouldValidate) {
    return Promise.all(
      this.getBlockQueuedItems().map(function(item) {
        return item.deferred;
      })
    ).then( () => {
      return this.getData(shouldValidate);
    });
  },

  /*
   * Validate all of our blocks, and serialise all data onto the JSON objects.
   * @param {Boolean} shouldValidate
   * @returns {Object} Object containg the data, canSubmit boolean and error count from the editor
   */
  getData: function(shouldValidate) {
    // if undefined or null or anything other than false - treat as true
    shouldValidate = (shouldValidate === false) ? false : true;

    this.mediator.trigger('errors:reset');
    this.store.reset();

    this.validateBlocks(shouldValidate);
    this.block_manager.validateBlockTypesExist(shouldValidate);

    this.mediator.trigger('errors:render');

    return {
      data: this.store.toString(),
      errors: this.errorHandler.errors.length,
      canSubmit: !(this.errorHandler.errors.length || this.getBlockQueuedItems().length)
    };
  },

  getBlockQueuedItems: function() {
    return this.block_manager.getQueuedItems();
  },

  validateBlocks: function(shouldValidate) {
    var self = this;
    Array.prototype.forEach.call(this.wrapper.querySelectorAll('.st-block'), function(block, idx) {
      var _block = self.findBlockById(block.getAttribute('id'));
      if (!_.isUndefined(_block)) {
        self.validateAndSaveBlock(_block, shouldValidate);
      }
    });
  },

  findBlockById: function(block_id) {
    return this.block_manager.findBlockById(block_id);
  },

  getBlocksByType: function(block_type) {
    return this.block_manager.getBlocksByType(block_type);
  },

  getBlocksByIDs: function(block_ids) {
    return this.block_manager.getBlocksByIDs(block_ids);
  },

  getBlockPosition: function(block) {
    var index;
    Array.prototype.forEach.call(this.wrapper.querySelectorAll('.st-block'), function(item, i) {
      if (block === item) {
        index = i;
      }
    });
    return index;
  },

  /**
   * Get the block which contains the current window selection.
   * @returns {Object} block - The block or undefined.
   */

  getBlockFromCurrentWindowSelection: function() {
    return this.findBlockById(
      Dom.getClosest(window.getSelection().anchorNode.parentNode, '.st-block').id
    );
  },

  _ensureAndSetElements: function() {
    if(_.isUndefined(this.options.el)) {
      utils.log("You must provide an el");
      return false;
    }

    this.el = this.options.el;

    this.outer = Dom.createElement("div", {
                  'class': 'st-outer notranslate', 
                  'dropzone': 'copy link move'});

    this.wrapper = Dom.createElement("div", {'class': 'st-blocks'});

    // Wrap our element in lots of containers *eww*

    Dom.wrap(Dom.wrap(this.el, this.outer), this.wrapper);

    return true;
  }

});

module.exports = Editor;


