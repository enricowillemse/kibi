define(function (require) {
  var _ = require('lodash');
  var SavedObjectNotFound = require('ui/errors').SavedObjectNotFound;

  return function KibiStateHelperFactory(timefilter, $rootScope, globalState, savedDashboards, Promise, config,
                                         $location, $timeout, Private, createNotifier) {

    var notify = createNotifier({
      location: 'KibiStateHelper'
    });

    var kibiSessionHelper = Private(require('ui/kibi/helpers/kibi_state_helper/kibi_session_helper'));

    /*
     * Helper class to manage the kibi state using globalState.k object
     * Note: use just letters for property names to make this object as small as possible
     */
    function KibiStateHelper() {
      this._init();
    }

    KibiStateHelper.prototype._properties = {
      filters: 'f',
      query: 'q',
      time: 't'
    };

    KibiStateHelper.prototype._init = function () {
      var self = this;
      if (!globalState.k) {
        globalState.k = {
          // will hold information about selected dashboards in each group
          g: {},
          // will hold information about each dashboard
          // each dashboard is a map whith following properties:
          //   q:, // queries
          //   f:, // filters
          //   t:  // time
          d: {},
          // will hold ids of enabled relations for relational panel and join_set filter
          j: [],
          // will hold the kibi session id
          s: undefined
        };
        globalState.save();
      };

      $rootScope.$on('kibi:dashboard:changed', function (event, dashboardId) {
        savedDashboards.get(dashboardId).then(function (savedDashboard) {
          self._updateTimeForOneDashboard(savedDashboard);
          globalState.save();
        });
      });

      $rootScope.$on('change:config.kibi:relationalPanel', function (event, enabled) {
        // if enabled === false
        // remove join_set filter
        if (enabled === false) {
          self.removeAllFiltersOfType('join_set');
        }
      });

      $rootScope.$on('kibi:join_set:removed', function () {
        self.removeAllFiltersOfType('join_set');
        self._disableAllRelations();
        $rootScope.$emit('kibi:update-tab-counts');
        $rootScope.$emit('kibi:update-relational-panel');
      });

      $rootScope.$on('kibi:session:changed:deleted', function (event, deletedId) {
        // destroy and init the session only if current one was deleted from elasticsearch
        kibiSessionHelper.getId().then(function (currentId) {
          if (currentId === deletedId) {
            kibiSessionHelper.destroy();
            kibiSessionHelper.init();
          }
        });
      });

      //NOTE: check if a timefilter has been set into the URL at startup
      var off = $rootScope.$on('$routeChangeSuccess', function () {
        $timeout(function () {
          if (timefilter.time) {
            var currentDashboardId;
            var currentPath = $location.path();
            if (currentPath && currentPath.indexOf('/dashboard/') === 0) {
              currentDashboardId = currentPath.replace('/dashboard/', '');
            }
            if (currentDashboardId) {
              self.saveTimeForDashboardId(currentDashboardId, timefilter.time.mode, timefilter.time.from, timefilter.time.to);
            }
          }
          if (globalState.k && !globalState.k.s) {
            // no sesion id
            kibiSessionHelper.getId().then(function (sessionId) {
              globalState.k.s = sessionId;
              globalState.save();
            }).catch(notify.error);
          } else if (globalState.k && globalState.k.s) {
            // there is a sesion id
            kibiSessionHelper.getId().then(function (sessionId) {
              if (globalState.k.s !== sessionId) {
                return kibiSessionHelper._copySessionFrom(globalState.k.s).then(function (savedSession) {
                  globalState.k.s = savedSession.id;
                  globalState.save();
                }).catch(function (err) {
                  notify.error(err);
                  if (err instanceof SavedObjectNotFound) {
                    // something happen and the session object does not exists anymore
                    // override the non-existing sessionId from the url
                    // to prevent the error happenning again
                    globalState.k.s = sessionId;
                    globalState.save();
                  }
                });
              }
            }).catch(notify.error);
          }
          off();
        });
      });


      this._updateTimeForAllDashboards();
    };


    /**
     * Returns true if the query is:
     * - a query_string
     * - a wildcard only
     * - analyze_wildcard is set to true
     */
    KibiStateHelper.prototype.isAnalyzedWildcardQueryString = function (query) {
      return query &&
        query.query_string &&
        query.query_string.query === '*' &&
        query.query_string.analyze_wildcard === true;
    };

    KibiStateHelper.prototype._updateTimeForOneDashboard = function (dashboard) {
      var skipGlobalStateSave = true;
      if (dashboard.timeRestore === true) {
        this.saveTimeForDashboardId(dashboard.id, dashboard.timeMode, dashboard.timeFrom, dashboard.timeTo, skipGlobalStateSave);
      } else {
        this.removeTimeForDashboardId(dashboard.id, skipGlobalStateSave);
      }
    };

    KibiStateHelper.prototype._updateTimeForAllDashboards = function () {
      var self = this;
      savedDashboards.find().then(function (resp) {
        if (resp.hits) {
          _.each(resp.hits, function (dashboard) {
            self._updateTimeForOneDashboard(dashboard);
          });
          globalState.save();
        }
      });
    };


    KibiStateHelper.prototype.saveSelectedDashboardId = function (groupId, dashboardId) {
      globalState.k.g[groupId] = dashboardId;
      globalState.save();
    };

    KibiStateHelper.prototype.getSelectedDashboardId = function (groupId) {
      return globalState.k.g[groupId];
    };

    KibiStateHelper.prototype.saveQueryForDashboardId = function (dashboardId, query) {
      if (query) {
        if (!this.isAnalyzedWildcardQueryString(query)) {
          this._setDashboardProperty(dashboardId, this._properties.query, query);
        } else {
          // store '*' instead the full query to make it more compact as this is very common query
          this._setDashboardProperty(dashboardId, this._properties.query, '*');
        }
      } else {
        this._deleteDashboardProperty(dashboardId, this._properties.query);
      }
      globalState.save();
    };

    KibiStateHelper.prototype.getQueryForDashboardId = function (dashboardId) {
      var q = this._getDashboardProperty(dashboardId, this._properties.query);

      if (q && q !== '*') {
        return q;
      } else if (q && q === '*') {
        // if '*' was stored make it again full query
        return {
          query_string: {
            analyze_wildcard: true,
            query: '*'
          }
        };
      }
    };

    KibiStateHelper.prototype.saveFiltersForDashboardId = function (dashboardId, filters) {
      if (!dashboardId) {
        return;
      }
      if (filters && filters.length > 0) {
        this._setDashboardProperty(dashboardId, this._properties.filters, filters);
      } else {
        // do NOT delete - instead store empty array
        // in other case the previous filters will be restored
        this._setDashboardProperty(dashboardId, this._properties.filters, []);
      }
      globalState.save();
    };

    KibiStateHelper.prototype._cleanFilters = function (filters) {
      return _.map(filters, function (f) {
        return _.omit(f, ['$state', '$$hashKey']);
      });
    };

    KibiStateHelper.prototype.getFiltersForDashboardId = function (dashboardId, includePinnedFilters = true) {
      var filters = this._getDashboardProperty(dashboardId, this._properties.filters);
      // add also pinned filters which are stored in global state
      if (filters && globalState.filters && includePinnedFilters) {
        return filters.concat(this._cleanFilters(globalState.filters));
      } else if (globalState.filters && globalState.filters.length > 0 && includePinnedFilters) {
        return this._cleanFilters(globalState.filters);
      }
      return filters;
    };

    /**
     * Returns a map of dashboardIds to filters
     */
    KibiStateHelper.prototype.getAllFilters = function () {
      const filters = {};

      for (const dashboardId in globalState.k.d) {
        if (globalState.k.d.hasOwnProperty(dashboardId)) {
          filters[dashboardId] = globalState.k.d[dashboardId].f || [];
        }
      }
      // add also pinned filters which are stored in global state
      if (globalState.filters && globalState.filters.length > 0) {
        for (let dashboardId in filters) {
          if (filters.hasOwnProperty(dashboardId)) {
            filters[dashboardId] = filters[dashboardId].concat(globalState.filters);
          }
        }
      }
      return filters;
    };

    KibiStateHelper.prototype.removeTimeForDashboardId = function (dashboardId, skipGlobalStateSave) {
      this._deleteDashboardProperty(dashboardId, this._properties.time);
      if (!skipGlobalStateSave) {
        globalState.save();
      }
    };

    KibiStateHelper.prototype.saveTimeForDashboardId = function (dashboardId, mode, from, to, skipGlobalStateSave) {
      let toStr = to;
      let fromStr = from;

      if (typeof from === 'object') {
        fromStr = from.toISOString();
      }
      if (typeof to === 'object') {
        toStr = to.toISOString();
      }
      this._setDashboardProperty(dashboardId, this._properties.time, {
        m: mode,
        f: fromStr,
        t: toStr
      });
      if (!skipGlobalStateSave) {
        globalState.save();
      }
    };

    KibiStateHelper.prototype.getTimeForDashboardId = function (dashboardId) {
      var t = this._getDashboardProperty(dashboardId, this._properties.time);
      if (t) {
        return {
          mode: t.m,
          from: t.f,
          to: t.t
        };
      }
      return null;
    };

    KibiStateHelper.prototype.addFilterToDashboard = function (dashboardId, filter) {
      if (globalState.k.d) {
        var filters = [];
        if (globalState.k.d[dashboardId] && globalState.k.d[dashboardId].f) {
          filters = globalState.k.d[dashboardId].f;
        }

        // here if there is a relational filter it should be replaced
        if (filter && filter.join_set) {
          // replace
          var index = -1;
          _.each(filters, function (f, i) {
            if (f.join_set) {
              index = i;
              return false;
            }
          });
          if (index !== -1) {
            // exists so replace
            filters[index] = filter;
          } else {
            // do not exists so add
            filters.push(filter);
          }
        } else if (filter) {
          // add
          filters.push(filter);
        } else {
          throw new Error('No filter');
        }
        this._setDashboardProperty(dashboardId, this._properties.filters, filters);
        globalState.save();
      }
    };

    KibiStateHelper.prototype.removeFilterOfTypeFromDashboard = function (type, dashboardId) {
      if (globalState.k.d) {
        var filters = [];
        if (globalState.k.d[dashboardId] && globalState.k.d[dashboardId].f) {
          filters = globalState.k.d[dashboardId].f;
        }
        filters = _.filter(filters, function (filter) {
          return !filter[type];
        });
        this._setDashboardProperty(dashboardId, this._properties.filters, filters);
        globalState.save();
      }
    };

    KibiStateHelper.prototype.removeAllFiltersOfType = function (type) {
      if (globalState.k.d) {
        _.each(globalState.k.d, function (dashboard, dashboardId) {
          globalState.k.d[dashboardId].f = _.filter(globalState.k.d[dashboardId].f, function (filter) {
            return !filter[type];
          });
        });
        globalState.save();
      }
    };


    KibiStateHelper.prototype.resetFiltersQueriesTimes = function () {
      if (globalState.k.d) {
        return savedDashboards.find().then((resp) => {
          if (resp.hits) {
            var timeDefaults = config.get('timepicker:timeDefaults');
            _.each(resp.hits, (dashboard) => {
              if (globalState.k.d[dashboard.id]) {
                const meta = JSON.parse(dashboard.kibanaSavedObjectMeta.searchSourceJSON);
                const filters = _.reject(meta.filter, (filter) => filter.query && filter.query.query_string && !filter.meta);
                const query = _.find(meta.filter, (filter) => filter.query && filter.query.query_string && !filter.meta);

                // query
                if (this.isAnalyzedWildcardQueryString(query)) {
                  globalState.k.d[dashboard.id].q = '*';
                } else {
                  globalState.k.d[dashboard.id].q = query && query.query || '*';
                }
                // filters
                globalState.k.d[dashboard.id].f = filters;
                // time
                if (dashboard.timeRestore && dashboard.timeFrom && dashboard.timeTo) {
                  this.saveTimeForDashboardId(dashboard.id, dashboard.timeMode, dashboard.timeFrom, dashboard.timeTo, true);
                } else {
                  this.saveTimeForDashboardId(dashboard.id, timeDefaults.mode, timeDefaults.from, timeDefaults.to, true);
                }
              }
            });
            globalState.save();
          }
        });
      }
      return Promise.resolve();
    };

    function makeRelationId(relation) {
      const parts = relation.relation.split('/');
      return `${relation.dashboards[0]}/${relation.dashboards[1]}/${parts[1]}/${parts[3]}`;
    }

    KibiStateHelper.prototype.isRelationEnabled = function (relation) {
      if (globalState.k.j instanceof Array) {
        return globalState.k.j.indexOf(makeRelationId(relation)) !== -1;
      }
      return false;
    };

    KibiStateHelper.prototype.getEnabledRelations = function () {
      var enabledRelations = globalState.k.j || [];
      return _.map(enabledRelations, function (rel) {
        var parts = rel.split('/');
        return [parts[0], parts[1]];
      });
    };

    KibiStateHelper.prototype.enableRelation = function (relation) {
      if (!globalState.k.j) {
        globalState.k.j = [];
      }
      const relationId = makeRelationId(relation);
      if (globalState.k.j.indexOf(relationId) === -1) {
        globalState.k.j.push(relationId);
        globalState.save();
      }
    };

    KibiStateHelper.prototype.disableRelation = function (relation) {
      if (!globalState.k.j) {
        globalState.k.j = [];
      }
      const relationId = makeRelationId(relation);
      const index = globalState.k.j.indexOf(relationId);
      if (index !== -1) {
        globalState.k.j.splice(index, 1);
        globalState.save();
      }
    };

    KibiStateHelper.prototype._disableAllRelations = function () {
      if (globalState.k.j) {
        globalState.k.j = [];
        globalState.save();
      }
    };

    KibiStateHelper.prototype._setDashboardProperty = function (dashboardId, prop, value) {
      if (!globalState.k.d[dashboardId]) {
        globalState.k.d[dashboardId] = {};
      }
      globalState.k.d[dashboardId][prop] = value;
    };

    KibiStateHelper.prototype._getDashboardProperty = function (dashboardId, prop) {
      if (!globalState.k.d[dashboardId]) {
        return undefined;
      }
      return globalState.k.d[dashboardId][prop];
    };

    KibiStateHelper.prototype._deleteDashboardProperty = function (dashboardId, prop) {
      if (!globalState.k.d[dashboardId]) {
        return;
      }
      delete globalState.k.d[dashboardId][prop];
      // check if this was the last and only
      // if yes delete the whole dashboard object
      if (Object.keys(globalState.k.d[dashboardId]).length === 0) {
        delete globalState.k.d[dashboardId];
      }
    };


    return new KibiStateHelper();
  };
});

