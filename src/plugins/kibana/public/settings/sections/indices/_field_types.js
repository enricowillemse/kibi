define(function (require) {
  return function GetFieldTypes() {
    var _ = require('lodash');

    return function (indexPattern) {
      var fieldCount = _.countBy(indexPattern.fields, function (field) {
        return (field.scripted) ? 'scripted' : 'indexed';
      });

      _.defaults(fieldCount, {
        indexed: 0,
        scripted: 0
      });

      return [
        {
          title: 'fields',
          index: 'indexedFields',
          count: fieldCount.indexed
        },
        {
          title: 'scripted fields',
          index: 'scriptedFields',
          count: fieldCount.scripted
        },
        // kibi: added by kibi
        {
          title: 'Retrieved Fields',
          index: 'sourceFiltering'
        }
      ];
    };
  };
});