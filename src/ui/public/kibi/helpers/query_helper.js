define(function (require) {

  var _ = require('lodash');

  return function QueryHelperFactory(savedVisualizations, Private, Promise, timefilter, indexPatterns) {

    var kibiTimeHelper   = Private(require('ui/kibi/helpers/kibi_time_helper'));
    var uniqFilters = require('ui/filter_bar/lib/uniqFilters');

    function QueryHelper() {
    }

    /**
     * GetVisualisations returns visualisations that are used by the list of queries
     */
    QueryHelper.prototype.getVisualisations = function (queryIds) {
      if (!queryIds) {
        return Promise.reject(new Error('Empty argument'));
      }
      return savedVisualizations.find('').then(function (resp) {
        var selectedQueries = [];

        var queryIds2 = _.map(queryIds, function (id) {
          return '"queryId":"' + id + '"';
        });
        var vis = _.filter(resp.hits, function (hit) {
          var list = _.filter(queryIds2, function (id, index) {
            if (hit.visState.indexOf(id) !== -1) {
              selectedQueries.push(queryIds[index]);
              return true;
            }
            return false;
          });
          return !!list.length;
        });
        return [ _(selectedQueries).compact().unique().value(), vis ];
      });
    };

    /**
     * GetLabels returns the set of indices which are connected to the focused index,
     * i.e., the connected component of the graph.
     */
    QueryHelper.prototype.getLabelOfIndexPatternsInConnectedComponent = function (focus, relations) {
      var labels = [];

      // the set of current nodes to visit
      var current = [ focus ];
      // the set of nodes to visit in the next iteration
      var toVisit = [];
      // the set of visited nodes
      var visited = [];


      do {

        // for each relation:
        // - if some node is in the current ones, then add the adjacent
        // node to toVisit if it was not visited already
        for (var i = 0; i < relations.length; i++) {
          var relation = relations[i];
          var ind = -1;
          var label = '';

          if (relation[0].indices.length !== 1 || relation[1].indices.length !== 1) {
            throw new Error('Expected indices of size 1, but got: ' + JSON.stringify(relation, null, ' '));
          }
          if ((ind = current.indexOf(relation[0].indices[0])) !== -1) {
            label = relation[1].indices[0];
          } else if ((ind = current.indexOf(relation[1].indices[0])) !== -1) {
            label = relation[0].indices[0];
          }

          if (!!label && label !== current[ind] && visited.indexOf(label) === -1) {
            toVisit.push(label);
          }
        }

        // update the visisted set
        for (var j = current.length - 1; j >= 0; j--) {
          labels.push(current[j]);
          visited.push(current.pop());
        }
        // update the current set
        for (var k = toVisit.length - 1; k >= 0; k--) {
          current.push(toVisit.pop());
        }

      } while (current.length !== 0);

      // TODO:
      // refactor see issue https://github.com/sirensolutions/kibi-internal/issues/500
      return _.uniq(labels);
    };

    /**
     * focus - is the focused index id
     *
     * relations - array of enabled relations
     *
     * filtersPerIndex should be an object
     * {
     *   indexId1: [],
     *   indexId2: [],
     *   ...
     * }
     * queriesPerIndex should be an object
     * {
     *   indexId1: [],
     *   indexId2: [],
     *   ...
     * }
     * indexDashboardsMap should be an object
     * {
     *   indexId1: [],
     *   indexId2: [],
     *   ...
     * }
     */
    QueryHelper.prototype.constructJoinFilter = function (focus, relations, filtersPerIndex, queriesPerIndex, indexToDashboardsMap) {
      // compute part of the label
      var labels = this.getLabelOfIndexPatternsInConnectedComponent(focus, relations);
      labels.sort();

      var labelValue;

      if (!indexToDashboardsMap) {
        labelValue = labels.join(' <-> ');
      } else {
        labelValue = _(labels).map(function (index) {
          return indexToDashboardsMap[index];
        }).flatten().value().join(' <-> ');
      }

      var joinFilter = {
        meta: {
          alias: labelValue
        },
        join_set: {
          focus: focus,
          relations: relations,
          queries: {}
        }
      };

      // here iterate over queries and add to the filters only this one which are not for focused index
      if (queriesPerIndex) {
        _.each(queriesPerIndex, function (queries, index) {
          if (index !== focus && queries instanceof Array && queries.length > 0) {
            if (!joinFilter.join_set.queries[index]) {
              joinFilter.join_set.queries[index] = [];
            }
            _.each(queries, function (fQuery) {
              // filter out only query_string queries that are only a wildcard
              if (fQuery && (!fQuery.query_string || fQuery.query_string.query !== '*')) {
                if (!joinFilter.join_set.queries[index]) {
                  joinFilter.join_set.queries[index] = [];
                }
                joinFilter.join_set.queries[index].push({ query: fQuery });
              }
            });
          }
        });
      }

      if (filtersPerIndex) {
        _.each(filtersPerIndex, function (filters, index) {
          if (index !== focus && filters instanceof Array && filters.length > 0) {
            if (!joinFilter.join_set.queries[index]) {
              joinFilter.join_set.queries[index] = [];
            }
            _.each(filters, function (fFilter) {
              // clone it first so when we remove meta the original object is not modified
              var filter = _.cloneDeep(fFilter);
              if (filter.meta && filter.meta.negate === true) {
                delete filter.meta;
                delete filter.$state;
                filter = {
                  not: filter
                };
              } else if (filter.meta) {
                delete filter.meta;
                delete filter.$state;
              }

              joinFilter.join_set.queries[index].push(filter);
            });
          }
        });
      }

      // update the timeFilter
      // indexToDashboardsMap - contains an array now
      // so we have to add all time filters
      var promises1 = [];
      _.each(labels, function (indexId) {
        if (indexId !== focus) {
          promises1.push(indexPatterns.get(indexId));
        }
      });

      return Promise.all(promises1).then(function (results1) {
        var promises2 = [];
        _.each(results1, function (indexPattern) {

          var indexId = indexPattern.id;
          var timeFilter = timefilter.get(indexPattern);

          if (timeFilter) {
            if (indexToDashboardsMap) {
              _.each(indexToDashboardsMap[indexId], function (dashboardId) {
                promises2.push(kibiTimeHelper.updateTimeFilterForDashboard(dashboardId, timeFilter)
                .then(function (updatedTimeFilter) {
                  return {
                    indexId: indexId,
                    timeFilter: updatedTimeFilter
                  };
                }));
              });
            } else {
              promises2.push(Promise.resolve({
                indexId: indexId,
                timeFilter: timeFilter
              }));
            }
          }
        });

        return Promise.all(promises2).then(function (results2) {

          // here all correctly updated time filters
          _.each(results2, function (res) {
            var indexId = res.indexId;
            var timeFilter = res.timeFilter;
            if (!joinFilter.join_set.queries[indexId]) {
              joinFilter.join_set.queries[indexId] = [];
            }
            joinFilter.join_set.queries[indexId].push(timeFilter);
            // here remove any duplicates
            joinFilter.join_set.queries[indexId] = uniqFilters(joinFilter.join_set.queries[indexId]);
          });

          return joinFilter;
        });
      });
    };

    return new QueryHelper();
  };

});
