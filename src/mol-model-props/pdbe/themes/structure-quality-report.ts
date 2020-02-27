/**
 * Copyright (c) 2018 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 */

import { StructureQualityReport, StructureQualityReportProvider } from '../../../mol-model-props/pdbe/structure-quality-report';
import { Location } from '../../../mol-model/location';
import { StructureElement } from '../../../mol-model/structure';
import { ColorTheme, LocationColor } from '../../../mol-theme/color';
import { ThemeDataContext } from '../../../mol-theme/theme';
import { Color } from '../../../mol-util/color';
import { TableLegend } from '../../../mol-util/legend';
import { ParamDefinition as PD } from '../../../mol-util/param-definition';
import { CustomProperty } from '../../common/custom-property';

const ValidationColors = [
    Color.fromRgb(170, 170, 170), // not applicable
    Color.fromRgb(0, 255, 0), // 0 issues
    Color.fromRgb(255, 255, 0), // 1
    Color.fromRgb(255, 128, 0), // 2
    Color.fromRgb(255, 0, 0), // 3 or more
]

const ValidationColorTable: [string, Color][] = [
    ['No Issues', ValidationColors[1]],
    ['One Issue', ValidationColors[2]],
    ['Two Issues', ValidationColors[3]],
    ['Three Or More Issues', ValidationColors[4]],
    ['Not Applicable', ValidationColors[9]]
]

export const StructureQualityReportColorThemeParams = {
    type: PD.MappedStatic('issue-count', {
        'issue-count': PD.Group({}),
        'specific-issue': PD.Group({
            kind: PD.Text()
        })
    })
};

type Params = typeof StructureQualityReportColorThemeParams

export function StructureQualityReportColorTheme(ctx: ThemeDataContext, props: PD.Values<Params>): ColorTheme<Params> {
    let color: LocationColor

    if (ctx.structure && !ctx.structure.isEmpty && ctx.structure.models[0].customProperties.has(StructureQualityReportProvider.descriptor)) {
        const getIssues = StructureQualityReport.getIssues;

        if (props.type.name === 'issue-count') {
            color = (location: Location) => {
                if (StructureElement.Location.is(location)) {
                    return ValidationColors[Math.min(3, getIssues(location).length) + 1];
                }
                return ValidationColors[0];
            }
        } else {
            const issue = props.type.params.kind;
            color = (location: Location) => {
                if (StructureElement.Location.is(location) && getIssues(location).indexOf(issue) >= 0) {
                    return ValidationColors[4];
                }
                return ValidationColors[0];
            }
        }
    } else {
        color = () => ValidationColors[0];
    }

    return {
        factory: StructureQualityReportColorTheme,
        granularity: 'group',
        color: color,
        props: props,
        description: 'Assigns residue colors according to the number of issues or a specific issue in the PDBe Validation Report.',
        legend: TableLegend(ValidationColorTable)
    }
}

export const StructureQualityReportColorThemeProvider: ColorTheme.Provider<Params> =  {
    label: 'PDBe Structure Quality Report',
    category: 'PDBe',
    factory: StructureQualityReportColorTheme,
    getParams: ctx => {
        const issueTypes = StructureQualityReport.getIssueTypes(ctx.structure);
        if (issueTypes.length === 0) {
            return {
                type: PD.MappedStatic('issue-count', {
                    'issue-count': PD.Group({})
                })
            };
        }

        return {
            type: PD.MappedStatic('issue-count', {
                'issue-count': PD.Group({}),
                'specific-issue': PD.Group({
                    kind: PD.Select(issueTypes[0], PD.arrayToOptions(issueTypes))
                }, { isFlat: true })
            })
        };
    },
    defaultValues: PD.getDefaultValues(StructureQualityReportColorThemeParams),
    isApplicable: (ctx: ThemeDataContext) => StructureQualityReport.isApplicable(ctx.structure?.models[0]),
    ensureCustomProperties: (ctx: CustomProperty.Context, data: ThemeDataContext) => {
        return data.structure ? StructureQualityReportProvider.attach(ctx, data.structure.models[0]) : Promise.resolve()
    }
}