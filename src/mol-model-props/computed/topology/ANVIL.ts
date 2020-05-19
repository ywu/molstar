/**
 * Copyright (c) 2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Sebastian Bittrich <sebastian.bittrich@rcsb.org>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Task, RuntimeContext } from '../../../mol-task';
import { ParamDefinition as PD } from '../../../mol-util/param-definition';
import { Structure, StructureElement, StructureProperties } from '../../../mol-model/structure';
import { getElementMoleculeType } from '../../../mol-model/structure/util';
import { MoleculeType } from '../../../mol-model/structure/model/types';
import { CentroidHelper } from '../../../mol-math/geometry/centroid-helper';
import { Vec3 } from '../../../mol-math/linear-algebra';
import { AccessibleSurfaceArea } from '../accessible-surface-area/shrake-rupley';
import { AccessibleSurfaceAreaProvider } from '../accessible-surface-area';

export const ANVILParams = {
    numberOfSpherePoints: PD.Numeric(350),
    stepSize: PD.Numeric(1),
    minThickness: PD.Numeric(20, { min: 10, max: 30, step: 1}, { description: 'Minimum membrane thickness used during refinement' }),
    maxThickness: PD.Numeric(40, { min: 30, max: 50, step: 1}, { description: 'Maximum membrane thickness used during refinement' }),
    afilter: PD.Numeric(40),
    membranePointDensity: PD.Numeric(2, { min: 0.1, max: 10, step: 0.1 }, { description: 'Distance betwween points representing membrane layer'})
};
export type ANVILParams = typeof ANVILParams
export type ANVILProps = PD.Values<ANVILParams>

export { Topology };

interface Topology {
    readonly membrane: Vec3[]
}

namespace Topology {
    /**
     * Implements:
     * Membrane positioning for high- and low-resolution protein structures through a binary classification approach
     * Guillaume Postic, Yassine Ghouzam, Vincent Guiraud, and Jean-Christophe Gelly
     * Protein Engineering, Design & Selection, 2015, 1–5
     * doi: 10.1093/protein/gzv063
     */
    export function compute(structure: Structure, props: Partial<ANVILProps> = {}) {
        const p = { ...PD.getDefaultValues(ANVILParams), ...props };
        return Task.create('Compute Membrane Topology', async runtime => {
            return await calculate(runtime, structure, p);
        });
    }

    const l = StructureElement.Location.create(void 0);
    const centroidHelper = new CentroidHelper();
    const vec = Vec3();
    export async function calculate(runtime: RuntimeContext, structure: Structure, params: ANVILProps): Promise<Topology> {
        const { label_atom_id, x, y, z } = StructureProperties.atom;
        const { label_comp_id } = StructureProperties.residue;
        const elementCount = structure.polymerResidueCount;
        centroidHelper.reset();
        l.structure = structure;

        let offsets = new Int32Array(elementCount);
        let exposed: boolean[] = new Array<boolean>(elementCount);

        // ensure ASA
        const accessibleSurfaceArea = structure && AccessibleSurfaceAreaProvider.get(structure);
        const asa = accessibleSurfaceArea.value!;
        
        let m = 0;
        for (let i = 0, il = structure.units.length; i < il; ++i) {
            const unit = structure.units[i];
            const { elements } = unit;
            l.unit = unit;

            for (let j = 0, jl = elements.length; j < jl; ++j) {
                const eI = elements[j];
                l.element = eI;

                // consider only amino acids
                if (getElementMoleculeType(unit, eI) !== MoleculeType.Protein) {
                    continue;
                }

                // only CA is considered for downstream operations
                if (label_atom_id(l) !== 'CA') {
                    continue;
                }

                // while iterating use first pass to compute centroid
                Vec3.set(vec, x(l), y(l), z(l));
                centroidHelper.includeStep(vec);

                // keep track of offsets and exposed state to reuse
                offsets[m] = l.element;
                exposed[m] = AccessibleSurfaceArea.getValue(l, asa) > params.afilter;

                m++;
            }
        }

        // omit potentially empty tail
        offsets = offsets.slice(0, m);
        exposed = exposed.slice(0, m);

        // calculate centroid and extent
        centroidHelper.finishedIncludeStep();
        const centroid = centroidHelper.center;
        for (let k = 0, kl = offsets.length; k < kl; k++) {
            setLocation(l, structure, offsets[k]);
            Vec3.set(vec, x(l), y(l), z(l));
            centroidHelper.radiusStep(vec);
        }
        const extent = 1.2 * Math.sqrt(centroidHelper.radiusSq);

        const initialHphobHphil = HphobHphil.filtered(offsets, exposed, structure, label_comp_id);
        const initialMembrane = findMembrane(generateSpherePoints(params.numberOfSpherePoints, centroid, extent), centroid, params, initialHphobHphil, offsets, exposed, structure, label_comp_id);
        const alternativeMembrane = findMembrane(findProximateAxes(initialMembrane, params.numberOfSpherePoints, centroid, extent), centroid, params, initialHphobHphil, offsets, exposed, structure, label_comp_id);

        // const membrane = initialMembrane;
        const membrane = initialMembrane.qmax! > alternativeMembrane.qmax! ? initialMembrane : alternativeMembrane;

        return {
            membrane: createMembraneLayers(membrane, extent, params)
        };
    }

    function createMembraneLayers(membrane: Membrane, extent: number, params: ANVILProps): Vec3[] {
        const out: Vec3[] = [];
        const radius = extent * extent;
        const normalVector = membrane.normalVector!;

        createMembraneLayer(out, membrane.planePoint1, normalVector, params.membranePointDensity, radius);
        createMembraneLayer(out, membrane.planePoint2, normalVector, params.membranePointDensity, radius);
        
        return out;
    }

    function createMembraneLayer(out: Vec3[], point: Vec3, normalVector: Vec3, density: number, radius: number) {
        const d = -Vec3.dot(normalVector, point);
        for (let i = -1000, il = 1000; i < il; i += density) {
            for (let j = -1000, jl = 1000; j < jl; j += density) {
                const rep = Vec3.create(i, j, -(d + i * normalVector[0] + j * normalVector[1]) / normalVector[2]);
                if (Vec3.squaredDistance(rep, point) < radius) {
                    out.push(rep);
                }
            }
        }
    }

    interface Membrane {
        planePoint1: Vec3,
        planePoint2: Vec3,
        stats: HphobHphil,
        normalVector?: Vec3,
        spherePoint?: Vec3,
        center?: Vec3,
        qmax?: number,
        membraneAtoms?: Vec3[]
    }

    namespace Membrane {
        export function initial(c1: Vec3, c2: Vec3, stats: HphobHphil): Membrane {
            return {
                planePoint1: c1,
                planePoint2: c2,
                stats: stats
            }
        }

        export function scored(spherePoint: Vec3, c1: Vec3, c2: Vec3, stats: HphobHphil, qmax: number, center: Vec3): Membrane {
            const diam_vect = Vec3();
            Vec3.sub(diam_vect, center, spherePoint);
            return {
                planePoint1: c1,
                planePoint2: c2,
                stats: stats,
                normalVector: diam_vect,
                spherePoint: spherePoint,
                center: center,
                qmax: qmax,
                membraneAtoms: []
            }
        }
    }

    function findMembrane(spherePoints: Vec3[], centroid: Vec3, params: ANVILProps, initialStats: HphobHphil, offsets: ArrayLike<number>, exposed: ArrayLike<boolean>, structure: Structure, label_comp_id: StructureElement.Property<string>): Membrane {
        // best performing membrane
        let membrane: Membrane | undefined = void 0;
        // score of the best performing membrane
        let qmax = 0;

        // construct slices of thickness 1.0 along the axis connecting the centroid and the spherePoint
        for (let i = 0, il = spherePoints.length; i < il; i++) {
            const spherePoint = spherePoints[i];
            const diam = Vec3();
            Vec3.sub(diam, centroid, spherePoint);
            Vec3.scale(diam, diam, 2);
            const diamNorm = Vec3.magnitude(diam);
            const qvartemp = [];

            for (let i = 0, il = diamNorm - params.stepSize; i < il; i += params.stepSize) {
                const c1 = Vec3();
                const c2 = Vec3();
                Vec3.scaleAndAdd(c1, spherePoint, diam, i / diamNorm);
                Vec3.scaleAndAdd(c2, spherePoint, diam, (i + params.stepSize) / diamNorm);

                // evaluate how well this membrane slice embeddeds the peculiar residues
                const stats = HphobHphil.filtered(offsets, exposed, structure, label_comp_id, (testPoint: Vec3) => isInMembranePlane(testPoint, diam, c1, c2));
                qvartemp.push(Membrane.initial(c1, c2, stats));
            }

            let jmax = (params.minThickness / params.stepSize) - 1;

            for (let width = 0, widthl = params.maxThickness; width < widthl;) {
                const imax = qvartemp.length - 1 - jmax;

                for (let i = 0, il = imax; i < il; i++) {
                    const c1 = qvartemp[i].planePoint1;
                    const c2 = qvartemp[i + jmax].planePoint2;

                    let hphob = 0;
                    let hphil = 0;
                    let total = 0;
                    for (let j = 0; j < jmax; j++) {
                        const ij = qvartemp[i + j];
                        if (j == 0 || j === jmax - 1) {
                            hphob += 0.5 * ij.stats.hphob;
                            hphil += 0.5 * ij.stats.hphil;
                        } else {
                            hphob += ij.stats.hphob;
                            hphil += ij.stats.hphil;
                        }
                        total += ij.stats.total;
                    }

                    const stats = HphobHphil.of(hphob, hphil, total);

                    if (hphob !== 0) {
                        const qvaltest = qValue(stats, initialStats);
                        if (qvaltest > qmax) {
                            qmax = qvaltest;
                            console.log(Vec3.distance(c1, c2) + ' ' + qmax);
                            membrane = Membrane.scored(centroid, c1, c2, HphobHphil.of(hphob, hphil, total), qmax, spherePoint);
                        }
                    }
                }
                jmax++;
                width = (jmax + 1) * params.stepSize
            }
        }

        return membrane!;
    }

    function qValue(currentStats: HphobHphil, initialStats: HphobHphil): number {
        if(initialStats.hphob < 1) {
            initialStats.hphob = 0.1;
        }

        if(initialStats.hphil < 1) {
            initialStats.hphil += 1;
        }

        const tot = initialStats.hphob + initialStats.hphil;
        const part_tot = currentStats.hphob + currentStats.hphil;

        return (currentStats.hphob * (initialStats.hphil - currentStats.hphil) - currentStats.hphil * (initialStats.hphob - currentStats.hphob)) /
                (part_tot * initialStats.hphob * initialStats.hphil * (tot - part_tot));
    }

    function isInMembranePlane(testPoint: Vec3, normalVector: Vec3, planePoint1: Vec3, planePoint2: Vec3): boolean {
        const d1 = -Vec3.dot(normalVector, planePoint1);
        const d2 = -Vec3.dot(normalVector, planePoint2);
        const d = -Vec3.dot(normalVector, testPoint);
        return d > Math.min(d1, d2) && d < Math.max(d1, d2);
    }

    // generates a defined number of points on a sphere with radius = extent around the specified centroid
    function generateSpherePoints(numberOfSpherePoints: number, centroid: Vec3, extent: number): Vec3[] {
        const points = new Array<Vec3>(numberOfSpherePoints);

        let oldPhi = 0, h, theta, phi;
        for(let k = 1, kl = numberOfSpherePoints + 1; k < kl; k++) {
            h = -1 + 2 * (k - 1) / (numberOfSpherePoints - 1);
            theta = Math.acos(h);
            phi = (k == 1 || k == numberOfSpherePoints) ? 0 : (oldPhi + 3.6 / Math.sqrt(numberOfSpherePoints * (1 - h * h))) % (2 * Math.PI);

            const point = Vec3.create(
                extent * Math.sin(phi) * Math.sin(theta) + centroid[0],
                extent * Math.cos(theta) + centroid[1],
                extent * Math.cos(phi) * Math.sin(theta) + centroid[2]
            );
            points[k - 1] = point;
            oldPhi = phi;
        }

        return points;
    }

    // generates sphere points close to that of the initial membrane
    function findProximateAxes(membrane: Membrane, numberOfSpherePoints: number, centroid: Vec3, extent: number): Vec3[] {
        const points = generateSpherePoints(30000, centroid, extent);
        // const sorted = points.sort((v1, v2) => Vec3.squaredDistance(v1, membrane.point!) - Vec3.squaredDistance(v2, membrane.point!));
        // return sorted.splice(0, numberOfSpherePoints);
        const imax = points.length;
        let j = 4;
        let sphere_pts2: Vec3[] = [];
        while (sphere_pts2.length < numberOfSpherePoints) {
            const d = 2 * extent / numberOfSpherePoints + j;
            const dsq = d * d;
            sphere_pts2 = [];
            for (let i = 0, il = imax; i < il; i++) {
                if (Vec3.squaredDistance(points[i], centroid) < dsq) {
                    sphere_pts2.push(points[i]);
                }
            }
            j += 0.2;
        }
        return sphere_pts2
    }

    interface HphobHphil {
        hphob: number, 
        hphil: number,
        total: number
    }

    namespace HphobHphil {
        export function of(hphob: number, hphil: number, total?: number) {
            return {
                hphob: hphob,
                hphil: hphil,
                total: !!total ? total : hphob + hphil 
            }
        }

        const testPoint = Vec3();
        export function filtered(offsets: ArrayLike<number>, exposed: ArrayLike<boolean>, structure: Structure, label_comp_id: StructureElement.Property<string>, filter?: (test: Vec3) => boolean): HphobHphil {
            const { x, y, z } = StructureProperties.atom;
            let hphob = 0;
            let hphil = 0;
            for (let k = 0, kl = offsets.length; k < kl; k++) {
                // ignore buried residues
                if (!exposed[k]) {
                    continue;
                }
    
                setLocation(l, structure, offsets[k]);
                Vec3.set(testPoint, x(l), y(l), z(l));

                // testPoints have to be in putative membrane layer
                if (filter && !filter(testPoint)) {
                    continue;
                }

                if (isHydrophobic(label_comp_id(l))) {
                    hphob++;
                } else {
                    hphil++;
                }
            }
            return of(hphob, hphil);
        }
    
        // ANVIL-specific (not general) definition of membrane-favoring amino acids
        const HYDROPHOBIC_AMINO_ACIDS = ['ALA', 'CYS', 'GLY', 'HIS', 'ILE', 'LEU', 'MET', 'PHE', 'SER', 'THR', 'VAL'];
        function isHydrophobic(label_comp_id: string): boolean {
            return HYDROPHOBIC_AMINO_ACIDS.indexOf(label_comp_id) !== -1;
        }
    }

    function setLocation(l: StructureElement.Location, structure: Structure, serialIndex: number) {
        l.structure = structure;
        l.unit = structure.units[structure.serialMapping.unitIndices[serialIndex]];
        l.element = structure.serialMapping.elementIndices[serialIndex];
        return l;
    }
}