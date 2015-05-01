/* global module, escape */
'use strict';

var SilentError  = require('ember-cli/lib/errors/silent');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var upstreamMergeTrees = require('broccoli-merge-trees');
var cleanBaseURL = require('ember-cli/lib/utilities/clean-base-url');
var Project = require('ember-cli/lib/models/project');
var preprocessors = require('ember-cli/lib/preprocessors');
var merge = require('lodash-node/modern/object/merge');
var defaults = require('lodash-node/modern/object/defaults');
var fs = require('fs');
var path = require('path');
var unwatchedTree = require('broccoli-unwatched-tree');
var configLoader = require('ember-cli/lib/broccoli/broccoli-config-loader');
var configReplace = require('ember-cli/lib/broccoli/broccoli-config-replace');
var ES6Modules = require('broccoli-es6Modules');
var stew = require('broccoli-stew');
var preprocessJs  = preprocessors.preprocessJs;
var preprocessTemplates = preprocessors.preprocessTemplates;
var preprocessCss = preprocessors.preprocessCss;
var preprocessMinifyCss = preprocessors.preprocessMinifyCss;
var rename = stew.rename;
var mv = stew.mv;
var find = stew.find;

function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);
  tree.description = options && options.description;
  return tree;
}

function flatten(arr) {
  return [].concat.apply([], arr);
}

function Builder(options) {
  options = options || {};

  this._initProject(options);

  this.env  = Builder.env();
  this.name = options.name || this.project.name();
  this.registry = options.registry || preprocessors.defaultRegistry(this);

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this.trees = this.options.trees;

  preprocessors.setupRegistry(this);
  this._notifyAddonIncluded();
}

Builder.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

Builder.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

Builder.prototype._initOptions = function(options, isProduction) {
  this.options = merge(options, {
    es3Safe: true,
    storeConfigInMeta: true,
    autoRun: true,
    outputPaths: {},
    minifyCSS: {
      enabled: !!isProduction,
      options: { relativeTo: 'app/styles' }
    },
    minifyJS: {
      enabled: !!isProduction,
    },
    sourcemaps: {},
    trees: {},
    jshintrc: {},
    'ember-cli-qunit': {
      disableContainerStyles: false
    }
  }, defaults);

  // TODO
  // Do we really need this
  this.options.outputPaths = merge(this.options.outputPaths, {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    },
    testSupport: {
      css: '/assets/test-support.css',
      js: {
        testSupport: '/assets/test-support.js',
        testLoader: '/assets/test-loader.js'
      }
    }
  }, defaults);

  this.options.sourcemaps = merge(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  }, defaults);

  this.options.trees = merge(this.options.trees, {
    app:       'app',
    tests:     'tests',
    // these are contained within app/ no need to watch again
    styles:    unwatchedTree('app/styles'),
    templates: fs.existsSync('app/templates') ? unwatchedTree('app/templates') : null,
    vendor: fs.existsSync('vendor') ? unwatchedTree('vendor') : null,
    public: fs.existsSync('public') ? 'public' : null
  }, defaults);

  this.options.jshintrc = merge(this.options.jshintrc, {
    app: this.project.root,
    tests: path.join(this.project.root, 'tests'),
  }, defaults);
};

Builder.prototype._notifyAddonIncluded = function() {
  this.initializeAddons();
  this.project.addons = this.project.addons.filter(function(addon) {
    addon.app = this;

    if (!addon.isEnabled || addon.isEnabled()) {

      if (addon.included) {
        addon.included(this);
      }

      return addon;
    }
  }, this);
};

Builder.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

Builder.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = configLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = mv(configTree, this.name + '/config');
  return this._cachedConfigTree;
};

Builder.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

Builder.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    content.push(fs.readFileSync(path.join(__dirname,'..', 'node_modules/ember-cli/lib/broccoli/app-config-from-meta.js')));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

Builder.prototype.contentFor = function(config, match, type) {
  var content = [];

  switch (type) {
    case 'head':          this._contentForHead(content, config);         break;
    case 'config-module': this._contentForConfigModule(content, config); break;
    case 'app-boot':      this._contentForAppBoot(content, config);      break;
  }

  content = this.project.addons.reduce(function(content, addon) {
    var addonContent = addon.contentFor ? addon.contentFor(type, config) : null;
    if (addonContent) {
      return content.concat(addonContent);
    }

    return content;
  }, content);

  return content.join('\n');
};

Builder.prototype._contentForAppBoot = function(content, config) {
  content.push('if (runningTests) {');
  content.push('  require("' +
    config.modulePrefix +
    '/tests/test-helper");');
  if (this.options.autoRun) {
    content.push('} else {');
    content.push('  require("' +
      config.modulePrefix +
      '/app")["default"].create(' +
      calculateAppConfig(config) +
      ');');
  }
  content.push('}');
};

Builder.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

Builder.prototype.testIndex = function() {
  var testIndexPath = this.name + '-tests/';

  var index = rename(this.trees.tests, function(relativePath) {
    return relativePath === 'index.html' ? testIndexPath + relativePath : relativePath;
  });

  return configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ testIndexPath + '/index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  });
};

Builder.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var index = rename(this.trees.app, function(relativePath) {
    return relativePath === 'index.html' ? htmlName : relativePath;
  });

  return configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  });
};

Builder.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      return addon.treeFor(type);
    }
  }, this).filter(Boolean);
};

Builder.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

Builder.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  var podPatterns = this._podTemplatePatterns();
  var excludePatterns = podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);

  return this._cachedFilterAppTree = find(this.trees.app, {
    exclude: excludePatterns
  });
};

// Merges an addons app directory with the consuming app
Builder.prototype._processedAppTree = function() {
  var filteredAddons = this.addonTreesFor('app').concat(this._filterAppTree());
  return mv(mergeTrees(filteredAddons, {
    overwrite: true,
    description: 'TreeMerger (app)'
  }), this.name);
};

Builder.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var mergedTrees = this.trees.templates ? addonTrees.concat(this.trees.templates) : addonTrees;
  var mergedTemplates = mergeTrees(mergedTrees, {
    overwrite: true,
    description: 'TreeMerger (templates)'
  });

  var standardTemplates = mv(mergedTemplates, this.name + '/templates');

  var podTemplates = mv(find(this.trees.app, {
    include: this._podTemplatePatterns(),
    exclude: [ /^templates/ ]
  }), this.name + '/');

  return preprocessTemplates(mergeTrees([standardTemplates, podTemplates]), {
    registry: this.registry,
    description: 'TreeMerger (pod & standard templates)'
  });
};

Builder.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;
  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });
  return workingTree;
};

Builder.prototype.addonLintTree = function(type, tree) {
  var output = [];
  this.project.addons.forEach(function(addon) {
    if (addon.lintTree) {
      output.push(addon.lintTree(type, tree));
    }
  });
  return mergeTrees(output,{
    overwrite: true,
    description: 'TreeMerger (lint)'
  });
};

Builder.prototype._addAppTests = function(sourceTrees) {
  if (this.tests) {
    if (this.hinting) {
      var jshintedApp = this.addonLintTree('app', this._filterAppTree());
      var jshintedTests = this.addonLintTree('tests', this.trees.tests);

      sourceTrees.push(
        mv(jshintedApp, this.name + '-tests'),
        mv(jshintedTests, this.name + '-tests')
      );
    }
  }
};

Builder.prototype.appAndDependencies = function() {
  var app = this._processedAppTree();
  var templates = this._processedTemplatesTree();
  var sourceTrees = [];

  if (!this.registry.availablePlugins['ember-cli-babel'] && this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  preprocessedApp = mergeTrees([preprocessedApp, templates]);

  sourceTrees.push(preprocessedApp);

  this._addAppTests(sourceTrees);

  return sourceTrees;
};

Builder.prototype.addonJavascript = function() {
  return this.addonTreesFor('addon');
};

Builder.prototype._processedTestsTree = function() {
  return mv(this.trees.tests, this.name + '-tests');
};

Builder.prototype.appTests = function() {
  var testTrees = [];

  if (this.tests) {
    var tests = this._processedTestsTree();
    var preprocessedTests = preprocessJs(tests, '/tests', this.name + '-tests', {
      registry: this.registry
    });

    testTrees.push(preprocessedTests);
  }

  return testTrees;
};

Builder.prototype.javascript = function() {
  var jsTrees = [];

  jsTrees = jsTrees.concat(
    this.appAndDependencies(),
    this.appTests(),
    this.addonJavascript()
  );

  return jsTrees.map(function(tree) {
    return new ES6Modules(tree, {
        description: 'ES6: App Tree',
        extensions: ['js'],
        exportDepGraph: true, // TODO: This does nothing right now
        esperantoOptions: {
          absolutePaths: true,
          strict: true,
          _evilES3SafeReExports: this.options.es3Safe
        }
      }
    );
  }, this);
};

Builder.prototype._configReplacePatterns = function() {
  return [{
    match: /\{\{EMBER_ENV\}\}/g,
    replacement: calculateEmberENV
  }, {
    match: /\{\{content-for ['"](.+)["']\}\}/g,
    replacement: this.contentFor.bind(this)
  }, {
    match: /\{\{MODULE_PREFIX\}\}/g,
    replacement: calculateModulePrefix
  }];
};

Builder.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public');

  if (this.trees.public) {
    trees.push(this.trees.public);
  }

  return mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerge (public)'
  });
};

Builder.prototype.styles = function() {
  if (fs.existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var styleTrees = [];
  styleTrees = styleTrees.concat(
    this.addonTreesFor('styles'),
    mv(this.trees.styles, this.name + '/app/styles')
  );

  var styles = mergeTrees(styleTrees, {
    description: 'TreeMerger (stylesAndAddons)',
    overwrite: true
  });

  var options = { outputPaths: this.options.outputPaths.app.css };
  options.registry = this.registry;
  var preprocessedStyles = preprocessCss(styles, '/app/styles', this.name + '/app/styles', options);

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
  }

  return preprocessedStyles;
};

Builder.prototype.toArray = function() {
  var sourceTrees = [
    this.index(),
    this.javascript(),
    this.publicTree(),
    this.styles()
  ];

  if (this.tests) {
    sourceTrees = sourceTrees.concat(this.testIndex());
  }

  return sourceTrees;
};

Builder.prototype.toTree = function(additionalTrees) {
  return flatten(this.toArray()).concat(additionalTrees || []);
};

Builder.env = function() {
  return process.env.EMBER_ENV || 'development';
};

function calculateBaseTag(config){
  var baseURL      = cleanBaseURL(config.baseURL);
  var locationType = config.locationType;

  if (locationType === 'hash') {
    return '';
  }

  if (baseURL) {
    return '<base href="' + baseURL + '" />';
  } else {
    return '';
  }
}

function calculateEmberENV(config) {
  return JSON.stringify(config.EmberENV || {});
}

function calculateModulePrefix(config) {
  return config.modulePrefix;
}

function calculateAppConfig(config) {
  return JSON.stringify(config.APP || {});
}

module.exports = Builder;
