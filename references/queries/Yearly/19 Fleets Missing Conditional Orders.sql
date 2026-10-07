select
	f.ExpectedConditionalOrders
	,fco_cnt.cnt
	--,f.FixedBody
	,*
FROM
(
	select
		--substr(f.FleetName,1,6) in ('___GAS'),
		*
		,CASE
			when f.FleetName like '%\_\_\_%' Escape '\' then --anything with triple underscore in the name
				-- cond ord for fuel level
				CASE
					when f.FleetName like '%NOGAS%' then 0 --NOGAS is used on gate fleets that are C only (no ST or SW)
					when f.FleetName like '%GAS%' then -- GAS stations
						CASE
							WHEN pi_fuelxfer.PopID is null then 1 	-- GAS station not at a colony with fuel transfer capability: cond ord expected
							else 0 									-- GAS station at a colony with fuel transfer capability: cond ord NOT expected
						END
					when f.FleetName like '%GATE%' then 1	--else if it has GAS or GATE in the name, add 1 for fuel level conditional order
					else 0
				END
				+
				-- cond ord for msp level
				CASE
					when f.FleetName like '%NOGAS%' then 0	--NOGAS is used on gate fleets that are C only (no ST or SW)
					when f.FleetName like '%GASSS%' then 1 -- GASSS station: cond ord expected
					when f.FleetName like '%MNT%' or f.FleetName like '%GATE%' then --else if it has MNT or GATE in the name	
						CASE
							WHEN pi_mf.PopID is null then 1 -- not in orbit of a ground colony with maintenance facilities: cond ord expected
							else 0							-- in orbit of a ground colony with maintenance facilities: cond ord not expected 
						END
					else 0
				end
			else 0
		end as ExpectedConditionalOrders
	FROM
		FCT_Fleet as f
	inner JOIN
		vw_const as c
	on
		c.RaceID = f.RaceID
	left JOIN
		FCT_Population as p
	on
		p.SystemBodyID = f.OrbitBodyID
	AND
		p.RaceID = f.RaceID
	left JOIN
		FCT_SystemBody as sb
	on
		sb.SystemBodyID = f.OrbitBodyID
	left join 
		(select PopID from FCT_PopulationInstallations where Amount > 0 and PlanetaryInstallationID = 21) as pi_mf -- maintenance facility
	on 
		pi_mf.PopID = p.PopulationID 	
	left join 
		(select distinct PopID from FCT_PopulationInstallations where Amount > 0 and PlanetaryInstallationID in (43, 33)) as pi_fuelxfer -- refuelling station or spaceport
	on 
		pi_fuelxfer.PopID = p.PopulationID 	
	
) as f
left JOIN
(
	SELECT
		fco.FleetID
		,count(*) as cnt
	FROM
		FCT_FleetConditionalOrder as fco
	group by
		fco.FleetID
) as fco_cnt
on fco_cnt.FleetID = f.FleetID
WHERE
(
	f.ExpectedConditionalOrders > IfNULL(fco_cnt.cnt,0)
	/*
		(f.ExpectedConditionalOrders = 2 and (f.ConditionOne = 0 or f.ConditionalOrderOne = 0 or f.ConditionTwo = 0 or f.ConditionalOrderTwo = 0))
	or
		(f.ExpectedConditionalOrders = 1 and (f.ConditionOne = 0 or f.ConditionalOrderOne = 0))
	or
		(f.ExpectedConditionalOrders > 2 )
	*/
)
	
